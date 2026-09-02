import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type Ladder, resolveLadder } from "../src/effort/ladder.ts";
import {
	type Decision,
	decide,
	initialState,
	type PolicyOptions,
	type PolicyState,
	recordUsage,
} from "../src/effort/policy.ts";
import { collectTurnSignals, type FailureSignal } from "../src/effort/signals.ts";
import { FIXTURES } from "./effort-fixtures.ts";

const ladderOf = (model: keyof typeof FIXTURES): Ladder => {
	const r = resolveLadder(FIXTURES[model]);
	if (!r.active) throw new Error(`inactive: ${r.reason}`);
	return r.ladder;
};

const FAIL: FailureSignal = { reason: "tests failed", detail: "\\bFAIL(ED)?\\b" };

class Run {
	state: PolicyState;
	decisions: Decision[] = [];
	turn = 0;
	options: PolicyOptions;
	constructor(options: PolicyOptions, prompt = "Add a widget", start: ModelThinkingLevel = "medium") {
		this.options = options;
		this.state = initialState(start);
		this.open(prompt);
	}
	open(prompt: string) {
		return this.step({ kind: "open", prompt, now: 0 });
	}
	step(signals: Parameters<typeof decide>[1]) {
		const decision = decide(this.state, signals, this.options);
		this.state = decision.state;
		this.decisions.push(decision);
		return decision;
	}
	turnEnd(opts: { failure?: FailureSignal; tools?: boolean; context?: number | null; now?: number } = {}) {
		return this.step({
			kind: "turn",
			turnIndex: this.turn++,
			failure: opts.failure,
			hadToolCalls: opts.tools ?? true,
			contextPercent: opts.context ?? 10,
			now: opts.now ?? this.turn * 1000,
		});
	}
	fail() {
		return this.turnEnd({ failure: FAIL });
	}
	clean() {
		return this.turnEnd();
	}
	levels() {
		return this.decisions.map((d) => d.to);
	}
}

describe("decide: ladder", () => {
	it("steps through available levels only: high → max on GLM-5.3, high → xhigh on Grok 4.6", () => {
		const glm = new Run({ ladder: ladderOf("glm53") });
		expect(glm.decisions[0].to).toBe("high");
		expect(glm.fail()).toMatchObject({ from: "high", to: "max", reason: "tests failed", arrow: "↑", changed: true });
		expect(glm.decisions.at(-1)?.signals).toEqual(["tests failed: \\bFAIL(ED)?\\b"]);

		const grok = new Run({ ladder: ladderOf("grok46") });
		expect(grok.fail().to).toBe("xhigh");
		grok.fail();
		expect(grok.fail().to).toBe("xhigh"); // ceiling with no rescue

		const grok45 = new Run({ ladder: ladderOf("grok45") });
		expect(grok45.fail()).toMatchObject({ to: "high", changed: false });
	});

	it("never emits a level the model does not support (randomised runs)", () => {
		let seed = 7;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (const key of Object.keys(FIXTURES) as Array<keyof typeof FIXTURES>) {
			const r = resolveLadder(FIXTURES[key]);
			if (!r.active) continue;
			const run = new Run({ ladder: r.ladder, budget: { costUsd: 5 } }, "Investigate why the build is red");
			for (let i = 0; i < 200; i++) {
				const roll = rand();
				if (roll < 0.1) run.open(rand() < 0.5 ? "Rename a to b" : "Design the cache layer");
				else if (roll < 0.15) run.state = recordUsage(run.state, { cost: { total: 0.4 } } as any);
				else run.turnEnd({ failure: rand() < 0.4 ? FAIL : undefined, tools: rand() < 0.8, context: rand() * 100 });
			}
			for (const d of run.decisions) expect(r.ladder.levels, `${key}: ${d.to}`).toContain(d.to);
		}
	});

	it("opens at ceiling / baseline / floor by phase and never above ceiling", () => {
		for (const key of ["sol", "gpt55", "codex", "glm53", "glm52", "grok46", "grok45"] as const) {
			const ladder = ladderOf(key);
			expect(new Run({ ladder }, "Investigate why startup is slow").decisions[0].to).toBe(ladder.ceiling);
			expect(new Run({ ladder }, "Rename foo to bar").decisions[0].to).toBe(ladder.floor);
			expect(new Run({ ladder }, "Add a widget").decisions[0].to).toBe(ladder.baseline);
		}
		const forced = new Run({ ladder: ladderOf("sol") });
		forced.state = { ...forced.state, forcedPhase: "investigate" };
		expect(forced.open("Rename foo to bar")).toMatchObject({ to: "high", reason: "investigate" });
		expect(forced.decisions.at(-1)?.signals).toEqual(["phase: investigate (forced)"]);
	});

	it("reaches rescue only after two consecutive failures at ceiling", () => {
		const run = new Run({ ladder: ladderOf("sol") });
		expect(run.fail().to).toBe("high"); // turn 0: baseline → ceiling
		expect(run.fail()).toMatchObject({ to: "high", changed: false }); // turn 1: first failure at ceiling
		expect(run.fail()).toMatchObject({ to: "xhigh", reason: "rescue" }); // turn 2: second → rescue
		expect(run.fail().to).toBe("xhigh"); // never beyond rescue

		const reset = new Run({ ladder: ladderOf("sol") });
		reset.fail();
		reset.fail();
		reset.clean(); // a clean turn resets the ceiling failure count
		expect(reset.fail()).toMatchObject({ to: "high", changed: false });
		expect(reset.fail().to).toBe("xhigh");
	});

	it("holds hysteresis: at most one change per two turns", () => {
		const run = new Run({ ladder: ladderOf("sol") }, "Rename foo to bar"); // opens at low
		expect(run.fail().to).toBe("medium"); // turn 0
		const held = run.fail(); // turn 1
		expect(held).toMatchObject({ to: "medium", changed: false, reason: "steady" });
		expect(held.signals).toContain("hysteresis: changed on turn 0");
		expect(run.fail().to).toBe("high"); // turn 2
	});

	it("steps down toward baseline after three clean turns with tool calls, never below it", () => {
		const run = new Run({ ladder: ladderOf("sol") }, "Investigate why startup is slow"); // opens at high
		run.clean();
		run.clean();
		run.turnEnd({ tools: false }); // no tool calls: does not count
		expect(run.state.cleanToolTurns).toBe(2);
		expect(run.clean()).toMatchObject({ to: "medium", reason: "clean", arrow: "↓" });
		for (let i = 0; i < 6; i++) run.clean();
		expect(run.state.level).toBe("medium");

		const mechanical = new Run({ ladder: ladderOf("sol") }, "Rename foo to bar"); // opens at low
		for (let i = 0; i < 6; i++) mechanical.clean();
		expect(mechanical.state.level).toBe("low"); // clean turns never move a level that is below baseline
	});
});

describe("decide: guards and pins", () => {
	it("caps at baseline above 70% context and at floor above 85%, overriding the ladder", () => {
		const run = new Run({ ladder: ladderOf("sol") }, "Investigate why startup is slow"); // high
		expect(run.turnEnd({ failure: FAIL, context: 72 })).toMatchObject({ to: "medium", reason: "context" });
		expect(run.turnEnd({ failure: FAIL, context: 90 })).toMatchObject({ to: "low", reason: "context" }); // immune to hysteresis
		expect(run.decisions.at(-1)?.signals).toEqual([
			"tests failed: \\bFAIL(ED)?\\b",
			"hysteresis: changed on turn 0",
			"context: 90%",
		]);
		expect(run.turnEnd({ context: null }).to).toBe("low"); // unknown usage: no cap, no ladder move
	});

	it("fires the budget cap exactly once and keeps it for the run", () => {
		const run = new Run({ ladder: ladderOf("sol"), budget: { costUsd: 1 } }, "Investigate why startup is slow");
		run.state = recordUsage(run.state, {
			input: 0,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 200,
			totalTokens: 500,
			cost: { input: 0, output: 1.2, cacheRead: 0, cacheWrite: 0, total: 1.2 },
		});
		const first = run.turnEnd();
		expect(first).toMatchObject({
			to: "low",
			reason: "budget",
			notify: "Effort capped at low for this run: cost $1.20 ≥ $1",
		});
		const second = run.fail();
		expect(second.to).toBe("low");
		expect(second.notify).toBeUndefined();
		expect(run.state.spent).toEqual({ costUsd: 1.2, outputTokens: 500, reasoningTokens: 200 });

		const wall = new Run(
			{ ladder: ladderOf("sol"), budget: { wallClockMinutes: 1 } },
			"Investigate why startup is slow",
		);
		expect(wall.turnEnd({ now: 30_000 }).to).toBe("high");
		expect(wall.turnEnd({ now: 61_000 })).toMatchObject({ to: "low", reason: "budget" });

		const tokens = new Run(
			{ ladder: ladderOf("sol"), budget: { outputTokens: 100 } },
			"Investigate why startup is slow",
		);
		tokens.state = recordUsage(tokens.state, { output: 150, cost: { total: 0 } } as any);
		expect(tokens.turnEnd().signals).toContain("budget: output 150 ≥ 100 tokens");
	});

	it("a user pin blocks every change until cleared", () => {
		const run = new Run({ ladder: ladderOf("sol") });
		run.state = { ...run.state, pinned: "low", level: "low" };
		expect(run.fail()).toMatchObject({ to: "low", changed: false, reason: "pinned" });
		expect(run.turnEnd({ failure: FAIL, context: 95 }).to).toBe("low");
		expect(run.open("Investigate why startup is slow")).toMatchObject({ to: "low", reason: "pinned" });
		run.state = { ...run.state, pinned: undefined };
		expect(run.fail().to).toBe("medium");
	});

	it("force jumps to the phase's opening level mid-run", () => {
		const run = new Run({ ladder: ladderOf("sol") });
		expect(run.step({ kind: "force", phase: "investigate" })).toMatchObject({ to: "high", reason: "investigate" });
		expect(run.state.forcedPhase).toBe("investigate");
		expect(run.step({ kind: "force", phase: "mechanical" }).to).toBe("low");
	});

	it("tracks a level histogram per run", () => {
		const run = new Run({ ladder: ladderOf("sol") });
		run.fail();
		run.clean();
		run.clean();
		expect(run.state.histogram).toEqual({ medium: 1, high: 2 });
		run.open("Add a widget");
		expect(run.state.histogram).toEqual({});
	});
});

describe("collectTurnSignals", () => {
	const assistant = (calls: Array<{ name: string; args: unknown }>, stopReason = "toolUse") =>
		({
			role: "assistant",
			stopReason,
			content: calls.map((c, i) => ({ type: "toolCall", id: `c${i}`, name: c.name, arguments: c.args })),
		}) as any;
	const result = (toolName: string, text: string, isError = false) => ({
		toolName,
		isError,
		content: [{ type: "text" as const, text }],
	});

	it("names the strongest signal in order: tests, edits, tool errors, doom loops, truncation", () => {
		const npm = collectTurnSignals(
			{
				message: assistant([{ name: "bash", args: { command: "npm test" } }]),
				toolResults: [result("bash", "Tests: 2 failed, 5 passed\nCommand exited with code 1", true)],
			},
			[],
		);
		expect(npm.failure).toEqual({ reason: "tests failed", detail: "Tests:\\s+\\d+ failed" });
		expect(npm.hadToolCalls).toBe(true);

		const edit = collectTurnSignals(
			{
				message: assistant([{ name: "edit", args: { path: "a" } }]),
				toolResults: [result("edit", "Found 3 occurrences of old text", true)],
			},
			[],
		);
		expect(edit.failure).toEqual({ reason: "edit failed", detail: "Found \\d+ occurrences" });

		const generic = collectTurnSignals(
			{ message: assistant([{ name: "read", args: { path: "x" } }]), toolResults: [result("read", "ENOENT", true)] },
			[],
		);
		expect(generic.failure).toEqual({ reason: "tool error", detail: "read" });

		const loop = collectTurnSignals(
			{ message: assistant([{ name: "bash", args: { command: "ls" } }]), toolResults: [result("bash", "a.txt")] },
			['bash:{"command":"pwd"}', 'bash:{"command":"ls"}'],
		);
		expect(loop.failure).toEqual({ reason: "doom loop", detail: 'bash:{"command":"ls"}' });
		expect(loop.recentCalls).toHaveLength(3);

		const cut = collectTurnSignals({ message: assistant([], "length"), toolResults: [] }, []);
		expect(cut.failure).toEqual({ reason: "truncated", detail: "stopReason=length" });
		expect(cut.hadToolCalls).toBe(false);
	});

	it("is clean for successful tool calls and honours configured test patterns", () => {
		const ok = collectTurnSignals(
			{
				message: assistant([{ name: "bash", args: { command: "npm test" } }]),
				toolResults: [result("bash", "Tests: 7 passed")],
			},
			[],
		);
		expect(ok.failure).toBeUndefined();
		const custom = collectTurnSignals(
			{ message: assistant([{ name: "bash", args: { command: "make" } }]), toolResults: [result("bash", "BOOM")] },
			[],
			{ testFailurePatterns: ["BOOM"] },
		);
		expect(custom.failure).toEqual({ reason: "tests failed", detail: "BOOM" });
	});
});
