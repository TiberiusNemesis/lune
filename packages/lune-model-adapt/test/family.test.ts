import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFamily, selectFamily } from "../src/family.ts";

describe("selectFamily", () => {
	it.each([
		["openai", "gpt-5.5", "gpt"],
		["openai", "gpt-5.3-codex", "codex"],
		["cerebras", "gpt-oss-120b", "gpt"],
		["openai", "gpt-4.1", "beast"],
		["openai", "o3-pro", "beast"],
		["anthropic", "claude-opus-4-7", "anthropic"],
		["google", "gemini-3.7-flash", "gemini"],
		["moonshotai", "kimi-k3", "kimi"],
		["kimi-for-coding", "k3-turbo", "kimi"],
		["deepseek", "deepseek-v4-pro", "default"],
		["zai", "glm-5.2", "default"],
	])("%s/%s -> %s", (provider, id, family) => {
		expect(selectFamily({ id, provider })).toBe(family);
	});
});

describe("resolveFamily", () => {
	const promptsDir = "/prompts";
	const cwd = "/work";
	const model = { id: "gpt-5.5", provider: "openai" };

	it("uses the built-in rule by default", () => {
		expect(resolveFamily(model, { promptsDir, cwd })).toEqual({
			family: "gpt",
			source: "builtin",
			file: "/prompts/gpt.md",
		});
	});

	it("applies the first matching override, ignoring invalid regexes", () => {
		const overrides = { "[": "kimi", "^openai/gpt-5": "anthropic", "gpt-5.5": "gemini" };
		expect(resolveFamily(model, { promptsDir, cwd, overrides })).toEqual({
			family: "anthropic",
			source: "override",
			file: "/prompts/anthropic.md",
		});
	});

	it("treats non-family override values as markdown paths relative to cwd", () => {
		const overrides = { "^openai/": "custom/gpt.md" };
		expect(resolveFamily(model, { promptsDir, cwd, overrides })).toEqual({
			family: "custom",
			source: "override",
			file: "/work/custom/gpt.md",
		});
	});

	it("lets the --prompt-family flag win over overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "lune-family-"));
		writeFileSync(join(dir, "mine.md"), "Custom prompt\n");
		const overrides = { ".*": "anthropic" };
		expect(resolveFamily(model, { promptsDir, cwd, overrides, flag: "kimi" }).family).toBe("kimi");
		expect(resolveFamily(model, { promptsDir, cwd, overrides, flag: join(dir, "mine.md") })).toEqual({
			family: "custom",
			source: "flag",
			file: join(dir, "mine.md"),
		});
	});
});
