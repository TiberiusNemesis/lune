/**
 * Which models get `apply_patch` instead of `edit`/`write`, and how the active tool set is swapped.
 * The built-in rule is OpenCode's (packages/opencode/src/tool/registry.ts lines 296-300).
 */

import type { ModelRef } from "./family.ts";

export const APPLY_PATCH = "apply_patch";
export const REPLACED_TOOLS = ["edit", "write"] as const;

export function usePatchForModel(model: ModelRef, patterns?: string[]): boolean {
	if (patterns && patterns.length > 0) {
		const key = `${model.provider}/${model.id}`;
		return patterns.some((pattern) => {
			try {
				return new RegExp(pattern).test(key);
			} catch {
				return false;
			}
		});
	}
	const id = model.id;
	return id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4");
}

export interface SwapState {
	/** Which replaced tools were active when the swap happened, so they can be restored. */
	swapped?: { edit: boolean; write: boolean };
}

/**
 * Compute the next active tool list. Only `apply_patch`, `edit` and `write` are ever added or
 * removed, so a user `--tools` allowlist is otherwise preserved. When editing is not allowed at
 * all (neither `edit` nor `write` active) `apply_patch` is not granted either.
 */
export function computeActiveTools(active: string[], usePatch: boolean, state: SwapState): string[] {
	const has = (name: string) => active.includes(name);
	const without = (...names: string[]) => active.filter((name) => !names.includes(name));

	if (usePatch) {
		if (!state.swapped) {
			if (!has("edit") && !has("write")) return without(APPLY_PATCH);
			state.swapped = { edit: has("edit"), write: has("write") };
		}
		const next = without("edit", "write");
		return next.includes(APPLY_PATCH) ? next : [...next, APPLY_PATCH];
	}

	const next = without(APPLY_PATCH);
	if (state.swapped) {
		for (const name of REPLACED_TOOLS) {
			if (state.swapped[name] && !next.includes(name)) next.push(name);
		}
		state.swapped = undefined;
	}
	return next;
}
