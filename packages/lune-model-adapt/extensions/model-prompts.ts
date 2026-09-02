/**
 * model-prompts: per-model system prompt family plus an environment block, ported from
 * OpenCode's SystemPrompt.provider() / SystemPrompt.environment().
 *
 * In before_agent_start pi's identity paragraph is replaced by the family prompt and the
 * <env> block; every other section of pi's prompt is preserved verbatim.
 *
 * Config (settings.json, global or project): `lune.modelPrompts.overrides`, a map of
 * regex on `provider/id` -> family name or path to a markdown file.
 * Flag: `--prompt-family <family|path>`. Command: `/prompt-family`.
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLuneConfig, type LuneConfig } from "../src/config.ts";
import { findGitRoot } from "../src/env.ts";
import { FAMILIES, type FamilyResolution, type ModelRef, resolveFamily } from "../src/family.ts";
import { assembleSystemPrompt, countWords, type EnvInfo } from "../src/prompt.ts";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export default function modelPromptsExtension(pi: ExtensionAPI) {
	pi.registerFlag("prompt-family", {
		description: `Prompt family (${FAMILIES.join("|")}) or path to a markdown prompt file`,
		type: "string",
	});

	let config: LuneConfig = {};
	const fileCache = new Map<string, string>();
	const gitRootCache = new Map<string, string | undefined>();

	function loadConfig(ctx: ExtensionContext): void {
		config = loadLuneConfig({
			global: join(getAgentDir(), "settings.json"),
			project: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json") : undefined,
		});
	}

	function resolve(model: ModelRef, ctx: ExtensionContext): FamilyResolution {
		const flag = pi.getFlag("prompt-family");
		return resolveFamily(model, {
			flag: typeof flag === "string" && flag.length > 0 ? flag : undefined,
			overrides: config.modelPrompts?.overrides,
			promptsDir: PROMPTS_DIR,
			cwd: ctx.cwd,
		});
	}

	function readFamilyText(file: string): string {
		const cached = fileCache.get(file);
		if (cached !== undefined) return cached;
		let text = "";
		try {
			text = readFileSync(file, "utf-8");
		} catch {
			// Missing override file: fall through with an empty family block.
		}
		fileCache.set(file, text);
		return text;
	}

	function gitRoot(cwd: string): string | undefined {
		if (!gitRootCache.has(cwd)) gitRootCache.set(cwd, findGitRoot(cwd));
		return gitRootCache.get(cwd);
	}

	function envInfo(model: ModelRef, cwd: string): EnvInfo {
		const root = gitRoot(cwd);
		return {
			modelId: model.id,
			provider: model.provider,
			cwd,
			workspaceRoot: root ?? cwd,
			isGitRepo: root !== undefined,
			platform: process.platform,
			date: new Date().toDateString(),
		};
	}

	function showStatus(ctx: ExtensionContext, model: ModelRef | undefined): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("prompt-family", model ? `prompt: ${resolve(model, ctx).family}` : undefined);
	}

	pi.on("session_start", (_event, ctx) => {
		fileCache.clear();
		gitRootCache.clear();
		loadConfig(ctx);
		showStatus(ctx, ctx.model);
	});

	pi.on("model_select", (event, ctx) => {
		showStatus(ctx, event.model);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const model = ctx.model;
		if (!model) return undefined;
		const resolution = resolve(model, ctx);
		return {
			systemPrompt: assembleSystemPrompt({
				basePrompt: event.systemPrompt,
				familyText: readFamilyText(resolution.file),
				env: envInfo(model, ctx.cwd),
				includeApplyPatch: pi.getActiveTools().includes("apply_patch"),
			}),
		};
	});

	pi.registerCommand("prompt-family", {
		description: "Show the active prompt family, its source file and word count",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "warning");
				return;
			}
			const resolution = resolve(model, ctx);
			const words = countWords(readFamilyText(resolution.file));
			ctx.ui.notify(
				`Prompt family: ${resolution.family} (${resolution.source}) for ${model.provider}/${model.id}\nFile: ${resolution.file}\nWords: ${words}`,
				"info",
			);
		},
	});
}
