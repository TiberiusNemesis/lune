/**
 * apply-patch: an `apply_patch` tool in the Codex / OpenCode `*** Begin Patch` format,
 * exposed only to GPT-family models. While active, `edit` and `write` are removed from the
 * active tool set and restored when the model changes back.
 *
 * Config (settings.json): `lune.applyPatch.models` (regex list replacing the built-in rule)
 * and `lune.applyPatch.allowOutsideWorkspace` (default false).
 */

import type { Model } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	generateDiffString,
	getAgentDir,
	renderDiff,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { applyPatch, type FileAction } from "../src/apply.ts";
import { loadLuneConfig, type LuneConfig } from "../src/config.ts";
import { APPLY_PATCH, computeActiveTools, type SwapState, usePatchForModel } from "../src/gating.ts";

const DESCRIPTION = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "apply_patch.txt"), "utf-8");
const STATE_ENTRY = "lune-apply-patch";

const parameters = Type.Object({
	patchText: Type.String({ description: "The full patch text that describes all changes to be made" }),
});

export interface ApplyPatchFileDetails {
	path: string;
	relativePath: string;
	action: FileAction;
	movePath?: string;
	/** Unified diff. */
	diff: string;
	/** Line-numbered diff for the TUI (same format as the edit tool). */
	displayDiff: string;
	firstChangedLine?: number;
	additions: number;
	deletions: number;
}

export interface ApplyPatchDetails {
	files: ApplyPatchFileDetails[];
	diff: string;
}

const ACTION_LETTER: Record<FileAction, string> = { add: "A", update: "M", move: "M", delete: "D" };

function patchHeaders(patchText: string | undefined): string[] {
	if (typeof patchText !== "string") return [];
	const headers: string[] = [];
	for (const match of patchText.matchAll(/^\s*\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/gm)) {
		headers.push(`${match[1][0]} ${match[2]}`);
	}
	return headers;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

export default function applyPatchExtension(pi: ExtensionAPI) {
	let config: LuneConfig = {};
	let state: SwapState = {};

	function loadConfig(ctx: ExtensionContext): void {
		config = loadLuneConfig({
			global: join(getAgentDir(), "settings.json"),
			project: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json") : undefined,
		});
	}

	/** The swap state is persisted as a custom entry so it survives /reload, which keeps the swapped tool set. */
	function restoreState(ctx: ExtensionContext, reason: string): void {
		state = {};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				const data = entry.data as { swapped?: SwapState["swapped"] | null } | undefined;
				state = { swapped: data?.swapped ?? undefined };
			}
		}
		const active = pi.getActiveTools();
		if (reason === "reload" && !state.swapped && active.includes(APPLY_PATCH) && !active.includes("edit")) {
			state.swapped = { edit: true, write: true };
		}
	}

	function applyGating(model: Model<any> | undefined): void {
		if (!model) return;
		const before = state.swapped;
		const active = pi.getActiveTools();
		const next = computeActiveTools(active, usePatchForModel(model, config.applyPatch?.models), state);
		if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
		if (before !== state.swapped) pi.appendEntry(STATE_ENTRY, { swapped: state.swapped ?? null });
	}

	pi.on("session_start", (event, ctx) => {
		loadConfig(ctx);
		restoreState(ctx, event.reason);
		applyGating(ctx.model);
	});

	pi.on("model_select", (event) => {
		applyGating(event.model);
	});

	pi.registerTool<typeof parameters, ApplyPatchDetails | undefined>({
		name: APPLY_PATCH,
		label: "apply_patch",
		description: DESCRIPTION,
		promptSnippet: "Edit files with a *** Begin Patch / *** End Patch document (Add/Update/Delete File)",
		promptGuidelines: [
			"Use apply_patch for manual code edits; use bash for bulk or mechanical changes such as formatters or search-and-replace across many files",
			"apply_patch paths are relative to the working directory and a failed patch changes no files, so fix the patch and retry instead of re-reading",
		],
		parameters,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const result = await applyPatch(params.patchText, {
				cwd: ctx.cwd,
				allowOutsideWorkspace: config.applyPatch?.allowOutsideWorkspace,
				mutate: withFileMutationQueue,
			});
			const files: ApplyPatchFileDetails[] = result.files.map((file) => {
				const display = generateDiffString(file.oldContent, file.newContent);
				return {
					path: file.path,
					relativePath: file.relativePath,
					action: file.action,
					movePath: file.movePath,
					diff: file.diff,
					displayDiff: display.diff,
					firstChangedLine: display.firstChangedLine,
					additions: file.additions,
					deletions: file.deletions,
				};
			});
			return {
				content: [{ type: "text", text: `${result.summary}\n\n${result.diff}`.trimEnd() }],
				details: { files, diff: result.diff },
			};
		},

		renderCall(args, theme) {
			const headers = patchHeaders(args?.patchText);
			const suffix = headers.length > 0 ? ` ${theme.fg("muted", headers.join(", "))}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("apply_patch"))}${suffix}`, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			const container = new Container();
			if (context.isError) {
				container.addChild(new Text(theme.fg("error", resultText(result)), 0, 0));
				return container;
			}
			if (!result.details) {
				container.addChild(new Text(resultText(result), 0, 0));
				return container;
			}
			for (const file of result.details.files) {
				const from = file.movePath ? theme.fg("dim", ` (from ${relative(context.cwd, file.path)})`) : "";
				const counts = theme.fg("dim", `+${file.additions} -${file.deletions}`);
				container.addChild(
					new Text(`${theme.fg("accent", ACTION_LETTER[file.action])} ${file.relativePath}${from} ${counts}`, 0, 0),
				);
				if (file.action !== "delete" && file.displayDiff) {
					container.addChild(new Text(renderDiff(file.displayDiff), 0, 0));
				}
			}
			return container;
		},
	});
}
