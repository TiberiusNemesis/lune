/**
 * Prompt family selection, reproducing OpenCode `SystemPrompt.provider()` substring rules
 * (packages/opencode/src/session/system.ts, commit 8e0f1c2). `muse`/`trinity` are skipped.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const FAMILIES = ["codex", "gpt", "beast", "gemini", "anthropic", "kimi", "default"] as const;
export type Family = (typeof FAMILIES)[number];

export interface ModelRef {
	id: string;
	provider: string;
}

const KIMI_PROVIDERS = ["kimi-for-coding", "moonshotai", "moonshotai-cn"];

export function selectFamily(model: ModelRef): Family {
	const id = model.id;
	if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3")) return "beast";
	if (id.includes("gpt")) return id.includes("codex") ? "codex" : "gpt";
	if (id.includes("gemini-")) return "gemini";
	if (id.includes("claude")) return "anthropic";
	if (id.toLowerCase().includes("kimi") || KIMI_PROVIDERS.includes(model.provider)) return "kimi";
	return "default";
}

export interface FamilyResolution {
	family: Family | "custom";
	source: "flag" | "override" | "builtin";
	/** Markdown file holding the family prompt. */
	file: string;
}

export interface ResolveFamilyOptions {
	/** `--prompt-family` value. A family name or a path to a markdown file. */
	flag?: string;
	/** `lune.modelPrompts.overrides`: regex on `provider/id` -> family name or markdown path. */
	overrides?: Record<string, string>;
	/** Directory holding the built-in `<family>.md` files. */
	promptsDir: string;
	/** Base for relative override paths. */
	cwd: string;
}

function isFamily(value: string): value is Family {
	return (FAMILIES as readonly string[]).includes(value);
}

function resolveValue(
	value: string,
	source: FamilyResolution["source"],
	options: ResolveFamilyOptions,
): FamilyResolution {
	if (isFamily(value)) return { family: value, source, file: join(options.promptsDir, `${value}.md`) };
	const expanded = value === "~" || value.startsWith("~/") ? homedir() + value.slice(1) : value;
	return { family: "custom", source, file: resolve(options.cwd, expanded) };
}

export function resolveFamily(model: ModelRef, options: ResolveFamilyOptions): FamilyResolution {
	if (options.flag) return resolveValue(options.flag, "flag", options);

	const key = `${model.provider}/${model.id}`;
	for (const [pattern, value] of Object.entries(options.overrides ?? {})) {
		let regex: RegExp;
		try {
			regex = new RegExp(pattern);
		} catch {
			continue;
		}
		if (regex.test(key)) return resolveValue(value, "override", options);
	}

	return resolveValue(selectFamily(model), "builtin", options);
}
