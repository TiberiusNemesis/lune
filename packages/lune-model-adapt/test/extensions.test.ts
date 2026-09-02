/**
 * Wiring tests: drive both extension factories with a fake ExtensionAPI and check the tool
 * swap, the persisted swap state, the command output and the rendered result.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import applyPatchExtension from "../extensions/apply-patch.ts";
import modelPromptsExtension from "../extensions/model-prompts.ts";

type Handler = (event: any, ctx: any) => any;

function fakePi(initialTools: string[]) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const flags = new Map<string, string | boolean | undefined>();
	let active = [...initialTools];
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const setActiveCalls: string[][] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: any) => {
			tools.set(tool.name, tool);
			if (!active.includes(tool.name)) active.push(tool.name);
		},
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerFlag: (name: string) => flags.set(name, undefined),
		getFlag: (name: string) => flags.get(name),
		getActiveTools: () => [...active],
		getAllTools: () => [...tools.values()],
		setActiveTools: (names: string[]) => {
			setActiveCalls.push([...names]);
			active = [...names];
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
		return result;
	};
	return { pi, emit, tools, commands, flags, entries, setActiveCalls, active: () => active };
}

const model = (provider: string, id: string) => ({ provider, id, name: id, api: "x" });

function fakeCtx(cwd: string, currentModel: any, branch: any[] = []) {
	const notifications: string[] = [];
	return {
		ctx: {
			cwd,
			model: currentModel,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => branch },
			ui: { notify: (message: string) => notifications.push(message), setStatus: () => {} },
		},
		notifications,
	};
}

let cwd: string;
initTheme("dark");
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "lune-ext-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("apply-patch extension", () => {
	it("registers apply_patch sequentially with prompt metadata", () => {
		const fake = fakePi(["read", "bash", "edit", "write"]);
		applyPatchExtension(fake.pi as any);
		const tool = fake.tools.get("apply_patch");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.promptSnippet).toContain("*** Begin Patch");
		expect(tool.promptGuidelines.join(" ")).toContain("apply_patch");
		expect(tool.description).toContain("*** Add File: <path>");
	});

	it("swaps tools on session_start and model_select and persists the swap", async () => {
		const fake = fakePi(["read", "bash", "edit", "write"]);
		applyPatchExtension(fake.pi as any);
		const gpt = model("openai", "gpt-5.5");
		const claude = model("anthropic", "claude-opus-4-7");

		await fake.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(cwd, gpt).ctx);
		expect(fake.active()).toEqual(["read", "bash", "apply_patch"]);
		expect(fake.entries.at(-1)).toEqual({
			type: "custom",
			customType: "lune-apply-patch",
			data: { swapped: { edit: true, write: true } },
		});

		await fake.emit("model_select", { type: "model_select", model: claude, previousModel: gpt, source: "set" }, {});
		expect(fake.active()).toEqual(["read", "bash", "edit", "write"]);
		expect(fake.entries.at(-1)?.data).toEqual({ swapped: null });

		await fake.emit("model_select", { type: "model_select", model: gpt, previousModel: claude, source: "set" }, {});
		expect(fake.active()).toEqual(["read", "bash", "apply_patch"]);
	});

	it("keeps apply_patch after a reload that carried the swapped tool set", async () => {
		const fake = fakePi(["read", "bash", "apply_patch"]);
		applyPatchExtension(fake.pi as any);
		await fake.emit(
			"session_start",
			{ type: "session_start", reason: "reload" },
			fakeCtx(cwd, model("openai", "gpt-5.5")).ctx,
		);
		expect(fake.active()).toEqual(["read", "bash", "apply_patch"]);
		await fake.emit("model_select", { type: "model_select", model: model("x", "glm-5.2"), source: "set" }, {});
		expect(fake.active()).toEqual(["read", "bash", "edit", "write"]);
	});

	it("does not touch a --tools allowlist without editing tools", async () => {
		const fake = fakePi(["read", "bash"]);
		applyPatchExtension(fake.pi as any);
		await fake.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			fakeCtx(cwd, model("openai", "gpt-5.5")).ctx,
		);
		expect(fake.active()).toEqual(["read", "bash"]);
	});

	it("executes a patch and renders per-file diffs", async () => {
		const fake = fakePi(["read", "bash", "edit", "write"]);
		applyPatchExtension(fake.pi as any);
		await writeFile(join(cwd, "a.txt"), "one\ntwo\n");
		const tool = fake.tools.get("apply_patch");
		const result = await tool.execute(
			"call-1",
			{ patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+2\n*** End Patch" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("Success. Updated the following files:\nM a.txt");
		expect(result.content[0].text).toContain("-two\n+2");
		expect(result.details.files[0]).toMatchObject({ relativePath: "a.txt", action: "update", firstChangedLine: 2 });
		expect(result.details.files[0].displayDiff).toContain("+2 2");

		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
		const rendered = tool.renderResult(result, { expanded: false }, theme, { cwd, isError: false });
		expect(rendered.render(80).join("\n")).toContain("M a.txt");
		const call = tool.renderCall({ patchText: "*** Begin Patch\n*** Update File: a.txt\n" }, theme, { cwd });
		expect(call.render(80).join("\n")).toContain("apply_patch U a.txt");
	});
});

describe("model-prompts extension", () => {
	it("rewrites the system prompt and reports the family", async () => {
		const fake = fakePi(["read", "bash", "edit", "write", "apply_patch"]);
		modelPromptsExtension(fake.pi as any);
		const { ctx, notifications } = fakeCtx(cwd, model("anthropic", "claude-opus-4-7"));
		await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

		const base =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help.\n\nGuidelines:\n- x\n\nCurrent working directory: /w";
		const result = await fake.emit(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hi", systemPrompt: base },
			ctx,
		);
		expect(result.systemPrompt).toContain("NEVER create files unless they are absolutely necessary");
		expect(result.systemPrompt).toContain(`  Working directory: ${cwd}`);
		expect(result.systemPrompt).toContain("Is directory a git repo: no");
		expect(result.systemPrompt.endsWith("Guidelines:\n- x\n\nCurrent working directory: /w")).toBe(true);

		await fake.commands.get("prompt-family").handler("", ctx);
		expect(notifications[0]).toMatch(
			/^Prompt family: anthropic \(builtin\) for anthropic\/claude-opus-4-7\nFile: .*anthropic\.md\nWords: \d+$/,
		);
	});

	it("honours --prompt-family and project overrides", async () => {
		const fake = fakePi(["read"]);
		modelPromptsExtension(fake.pi as any);
		const { ctx, notifications } = fakeCtx(cwd, model("openai", "gpt-5.5"));
		await writeFile(join(cwd, "settings.json"), "{}");
		await rm(join(cwd, "settings.json"));
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ lune: { modelPrompts: { overrides: { "^openai/": "kimi" } } } }),
		);
		await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await fake.commands.get("prompt-family").handler("", ctx);
		expect(notifications.at(-1)).toContain("Prompt family: kimi (override)");

		fake.flags.set("prompt-family", "gemini");
		await fake.commands.get("prompt-family").handler("", ctx);
		expect(notifications.at(-1)).toContain("Prompt family: gemini (flag)");
	});
});
