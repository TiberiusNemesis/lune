/**
 * Wiring test: drive the effort-policy extension with a stub ExtensionAPI that records
 * setThinkingLevel calls and appendEntry payloads, and echoes thinking_level_select the way
 * pi does (asynchronously, after the call returns).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import effortPolicyExtension, { type DecisionEntry, type SummaryEntry } from "../extensions/effort-policy.ts";
import { FIXTURES } from "./effort-fixtures.ts";

type Handler = (event: any, ctx: any) => any;

function harness(model: any, startLevel = "medium") {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const entries: Array<{ type: "custom"; customType: string; data: any }> = [];
	const setCalls: string[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	let level = startLevel;
	let contextPercent: number | null = 5;
	const ctx = {
		cwd: "/tmp",
		hasUI: true,
		isProjectTrusted: () => false,
		get model() {
			return model;
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 100, percent: contextPercent }),
		sessionManager: { getEntries: () => entries },
		ui: { notify: (m: string) => notifications.push(m), setStatus: (_k: string, t?: string) => statuses.push(t) },
	};
	const emit = async (event: string, payload: any = {}) => {
		for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
	};
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, options: any) => commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getThinkingLevel: () => level,
		setThinkingLevel: (next: string) => {
			setCalls.push(next);
			if (next === level) return;
			const previous = level;
			level = next;
			void emit("thinking_level_select", { level: next, previousLevel: previous });
		},
	};
	effortPolicyExtension(pi as any);
	const tick = () => new Promise((r) => setTimeout(r, 0));
	const userSets = async (next: string) => {
		const previous = level;
		level = next;
		await emit("thinking_level_select", { level: next, previousLevel: previous });
	};
	const bashFail = (text: string) => ({
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "npm test" } }],
			usage: { output: 10, reasoning: 4, cacheRead: 0, cost: { total: 0.01 } },
		},
		toolResults: [{ toolName: "bash", isError: true, content: [{ type: "text", text }] }],
	});
	const cleanTurn = (n: number) => ({
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: `c${n}`, name: "read", arguments: { path: `f${n}` } }],
			usage: { output: 10, reasoning: 4, cacheRead: 0, cost: { total: 0.01 } },
		},
		toolResults: [{ toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] }],
	});
	const decisions = () => entries.filter((e) => e.customType === "lune.effort").map((e) => e.data as DecisionEntry);
	const setModel = (next: any) => {
		model = next;
	};
	const setContext = (p: number | null) => {
		contextPercent = p;
	};
	return {
		ctx,
		emit,
		tick,
		commands,
		entries,
		setCalls,
		notifications,
		statuses,
		userSets,
		bashFail,
		cleanTurn,
		decisions,
		setModel,
		setContext,
		level: () => level,
	};
}

let agentDir: string;
beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "lune-effort-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(agentDir, { recursive: true, force: true });
});

describe("effort-policy extension", () => {
	it("opens by phase, steps up on a failed test run, logs the signal, and summarises the run", async () => {
		const h = harness(FIXTURES.sol);
		await h.emit("session_start", { reason: "startup" });
		expect(h.setCalls).toEqual([]); // medium is already inside the ladder
		expect(h.statuses.at(-1)).toBe("medium · ready");

		await h.commands.get("effort").handler("", h.ctx);
		expect(h.notifications.at(-1)).toContain("Effort: medium (baseline) · ladder low…high · rescue xhigh");
		expect(h.notifications.at(-1)).toContain("levels low · medium · high · xhigh · max");

		await h.emit("before_agent_start", { prompt: "Investigate why the build is red", systemPrompt: "" });
		expect(h.setCalls).toEqual(["high"]);
		expect(h.statuses.at(-1)).toBe("high ↑ investigate");
		await h.tick();
		expect(h.level()).toBe("high");

		// The echoed thinking_level_select is ours and must not pin.
		await h.emit("turn_end", { turnIndex: 0, ...h.cleanTurn(0) });
		await h.emit("message_end", h.cleanTurn(0));
		expect(h.decisions().at(-1)).toMatchObject({ turn: 0, from: "high", to: "high", reason: "steady" });

		await h.emit("agent_settled");
		const summary = h.entries.at(-1)?.data as SummaryEntry;
		expect(h.entries.at(-1)?.customType).toBe("lune.effort.summary");
		expect(summary).toMatchObject({
			phase: "investigate",
			turns: 1,
			levels: { high: 1 },
			costUsd: 0.01,
			outputTokens: 10,
			reasoningTokens: 4,
		});

		// Baseline prompt: medium; failing npm test → high with the matched signal.
		await h.emit("before_agent_start", { prompt: "Add a widget", systemPrompt: "" });
		expect(h.setCalls).toEqual(["high", "medium"]);
		await h.tick();
		await h.emit("message_end", h.bashFail(""));
		await h.emit("turn_end", { turnIndex: 0, ...h.bashFail("FAIL src/a.test.ts\nCommand exited with code 1") });
		expect(h.setCalls).toEqual(["high", "medium", "high"]);
		expect(h.statuses.at(-1)).toBe("high ↑ tests failed");
		expect(h.decisions().at(-1)).toMatchObject({
			turn: 0,
			from: "medium",
			to: "high",
			reason: "tests failed",
			signals: ["tests failed: \\bFAIL(ED)?\\b"],
			contextPercent: 5,
			costSoFar: 0.01,
			cacheRead: 0,
		});
		await h.commands.get("effort").handler("log", h.ctx);
		expect(h.notifications.at(-1)).toContain(
			"0 | medium → high | tests failed | 5% | $0.010 | 0 | tests failed: \\bFAIL(ED)?\\b",
		);
		expect(h.notifications.at(-1)).toContain(
			"open | high → medium | baseline | 5% | $0.000 | - | phase: baseline (default)",
		);
	});

	it("pins a user-selected level until /effort auto, and clears the pin on model change", async () => {
		const h = harness(FIXTURES.sol);
		await h.emit("session_start", { reason: "startup" });
		await h.emit("before_agent_start", { prompt: "Add a widget", systemPrompt: "" });
		await h.userSets("low");
		expect(h.statuses.at(-1)).toBe("low · pinned");
		await h.emit("turn_end", { turnIndex: 0, ...h.bashFail("FAIL") });
		await h.emit("turn_end", { turnIndex: 1, ...h.bashFail("FAIL") });
		expect(h.setCalls).toEqual([]);
		expect(h.decisions().at(-1)).toMatchObject({ to: "low", reason: "pinned" });

		await h.commands.get("effort").handler("auto", h.ctx);
		await h.emit("turn_end", { turnIndex: 2, ...h.bashFail("FAIL") });
		expect(h.setCalls).toEqual(["medium"]);

		await h.userSets("xhigh");
		h.setModel(FIXTURES.glm53);
		await h.emit("model_select", { model: FIXTURES.glm53, previousModel: FIXTURES.sol, source: "set" });
		expect(h.setCalls).toEqual(["medium", "high"]); // pin dropped, parked at GLM-5.3's baseline
		await h.commands.get("effort").handler("", h.ctx);
		expect(h.notifications.at(-1)).toContain("levels low · high · max");
		expect(h.notifications.at(-1)).not.toContain("pinned");
	});

	it("GLM-5.3: ladder low · high · max, failure steps high → max, never off", async () => {
		const h = harness(FIXTURES.glm53, "off");
		await h.emit("session_start", { reason: "startup" });
		expect(h.setCalls).toEqual(["high"]); // parked at baseline; off is never used
		await h.tick();
		await h.emit("before_agent_start", { prompt: "Add a widget", systemPrompt: "" });
		await h.tick();
		expect(h.level()).toBe("high");
		await h.emit("turn_end", { turnIndex: 0, ...h.bashFail("Tests: 1 failed") });
		expect(h.setCalls).toEqual(["high", "max"]);
		expect(h.statuses.at(-1)).toBe("max ↑ tests failed");
		for (const call of h.setCalls) expect(call).not.toBe("off");
	});

	it("Grok Build: reports the policy inactive and never sets a level", async () => {
		const h = harness(FIXTURES.grokBuild, "high");
		await h.emit("session_start", { reason: "startup" });
		await h.commands.get("effort").handler("", h.ctx);
		expect(h.notifications.at(-1)).toBe(
			"Effort policy inactive for xai/grok-build-0.1: disabled for /grok-build/. Nothing is set.",
		);
		await h.emit("before_agent_start", { prompt: "Investigate why the build is red", systemPrompt: "" });
		await h.emit("turn_end", { turnIndex: 0, ...h.bashFail("FAIL") });
		await h.emit("agent_settled");
		expect(h.setCalls).toEqual([]);
		expect(h.entries).toEqual([]);
		expect(h.statuses).toEqual([undefined]);
	});

	it("applies context guards, budget notification and forced phases", async () => {
		const h = harness(FIXTURES.sol);
		await h.emit("session_start", { reason: "startup" });
		await h.emit("before_agent_start", { prompt: "Investigate why the build is red", systemPrompt: "" });
		h.setContext(88);
		await h.emit("turn_end", { turnIndex: 0, ...h.cleanTurn(0) });
		expect(h.statuses.at(-1)).toBe("low ↓ context");
		h.setContext(10);
		await h.commands.get("effort").handler("plan", h.ctx);
		expect(h.setCalls.at(-1)).toBe("high");
		expect(h.decisions().at(-1)).toMatchObject({
			to: "high",
			reason: "investigate",
			signals: ["forced: investigate"],
		});
		await h.commands.get("effort").handler("xhigh", h.ctx);
		expect(h.setCalls.at(-1)).toBe("xhigh");
		expect(h.notifications.at(-1)).toBe("Effort pinned at xhigh");
		await h.commands.get("effort").handler("bogus", h.ctx);
		expect(h.notifications.at(-1)).toContain("Usage:");
	});
});
