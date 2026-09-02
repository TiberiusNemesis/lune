import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAMILIES, type Family, selectFamily } from "../src/family.ts";
import {
	assembleSystemPrompt,
	beforeProjectContext,
	buildEnvBlock,
	countWords,
	type EnvInfo,
	stripToolMentions,
} from "../src/prompt.ts";

const PROMPTS_DIR = join(import.meta.dirname, "..", "prompts");
const familyText = (family: Family) => readFileSync(join(PROMPTS_DIR, `${family}.md`), "utf-8");

/** Mirrors the shape of packages/coding-agent/src/core/system-prompt.ts with fixed paths. */
const BASE_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use read to examine files instead of cat or sed
- Use edit for precise changes (edits[].oldText must match exactly)
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/pi/README.md
- Additional docs: /opt/pi/docs
- Examples: /opt/pi/examples (extensions, custom tools, SDK)

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/work/AGENTS.md">
Run npm test before committing.
</project_instructions>

</project_context>

<available_skills>
  <skill>
    <name>demo</name>
  </skill>
</available_skills>

Current working directory: /work`;

const FIXED_MODELS: Record<Family, { provider: string; id: string }> = {
	codex: { provider: "openai", id: "gpt-5.3-codex" },
	gpt: { provider: "openai", id: "gpt-5.5" },
	beast: { provider: "openai", id: "gpt-4.1" },
	gemini: { provider: "google", id: "gemini-3.7-flash" },
	anthropic: { provider: "anthropic", id: "claude-opus-4-7" },
	kimi: { provider: "moonshotai", id: "kimi-k3" },
	default: { provider: "deepseek", id: "deepseek-v4-pro" },
};

const env = (family: Family): EnvInfo => ({
	modelId: FIXED_MODELS[family].id,
	provider: FIXED_MODELS[family].provider,
	cwd: "/work/app",
	workspaceRoot: "/work",
	isGitRepo: true,
	platform: "darwin",
	date: "Wed Sep 02 2026",
});

const assemble = (family: Family, includeApplyPatch = family === "gpt" || family === "codex") =>
	assembleSystemPrompt({
		basePrompt: BASE_PROMPT,
		familyText: familyText(family),
		env: env(family),
		includeApplyPatch,
	});

describe("family prompt files", () => {
	it.each(FAMILIES)("%s.md is at most 250 words", (family) => {
		expect(countWords(familyText(family))).toBeLessThanOrEqual(250);
	});

	it.each(FAMILIES)("%s.md matches the selector for its fixed model", (family) => {
		expect(selectFamily(FIXED_MODELS[family])).toBe(family);
	});

	it("only the GPT families mention apply_patch", () => {
		for (const family of FAMILIES) {
			expect(familyText(family).includes("apply_patch")).toBe(["gpt", "codex", "beast"].includes(family));
		}
	});
});

describe("assembleSystemPrompt", () => {
	it.each(FAMILIES)("%s snapshot", (family) => {
		expect(assemble(family)).toMatchSnapshot();
	});

	it.each(FAMILIES)("%s stays under 600 words before project context", (family) => {
		expect(countWords(beforeProjectContext(assemble(family)))).toBeLessThanOrEqual(600);
	});

	it("is byte-identical across turns for the same inputs", () => {
		expect(assemble("gpt")).toBe(assemble("gpt"));
	});

	it("replaces only the identity paragraph and keeps every other section verbatim", () => {
		const prompt = assemble("anthropic");
		const rest = BASE_PROMPT.slice(BASE_PROMPT.indexOf("\n\nAvailable tools:"));
		expect(prompt.endsWith(rest)).toBe(true);
		expect(prompt.startsWith(familyText("anthropic").trim())).toBe(true);
		expect(prompt).not.toContain(
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users",
		);
		expect(prompt).toContain(buildEnvBlock(env("anthropic")));
	});

	it("keeps text that earlier extensions placed before the identity paragraph", () => {
		const base = `You are lune, the Hexweavers coding agent, built on pi. Refer to yourself as lune.\n\n${BASE_PROMPT}`;
		const prompt = assembleSystemPrompt({
			basePrompt: base,
			familyText: familyText("gpt"),
			env: env("gpt"),
			includeApplyPatch: true,
		});
		expect(
			prompt.startsWith("You are lune, the Hexweavers coding agent, built on pi. Refer to yourself as lune.\n\n"),
		).toBe(true);
		expect(prompt).toContain(familyText("gpt").trim());
	});

	it("drops apply_patch lines when the tool is not active", () => {
		const withTool = assemble("gpt", true);
		const withoutTool = assemble("gpt", false);
		expect(withTool).toContain("apply_patch");
		expect(withoutTool).not.toContain("apply_patch");
		expect(withoutTool).not.toMatch(/\n{3,}/);
	});

	it("prepends only the environment block when the identity paragraph is absent (custom prompt)", () => {
		const custom = "You are a haiku bot.\n\nCurrent working directory: /work";
		const prompt = assembleSystemPrompt({
			basePrompt: custom,
			familyText: familyText("gpt"),
			env: env("gpt"),
			includeApplyPatch: true,
		});
		expect(prompt).toBe(`${buildEnvBlock(env("gpt"))}\n\n${custom}`);
	});

	it("renders the environment block like OpenCode", () => {
		expect(buildEnvBlock(env("gpt"))).toBe(
			[
				"You are powered by the model named gpt-5.5. The exact model ID is openai/gpt-5.5",
				"Here is some useful information about the environment you are running in:",
				"<env>",
				"  Working directory: /work/app",
				"  Workspace root folder: /work",
				"  Is directory a git repo: yes",
				"  Platform: darwin",
				"  Today's date: Wed Sep 02 2026",
				"</env>",
			].join("\n"),
		);
	});
});

describe("stripToolMentions", () => {
	it("removes mentioning lines and collapses blank runs", () => {
		expect(stripToolMentions("a\n\n- use apply_patch\n\nb", "apply_patch")).toBe("a\n\nb");
	});
});
