import { describe, expect, it } from "vitest";
import { computeActiveTools, type SwapState, usePatchForModel } from "../src/gating.ts";

describe("usePatchForModel", () => {
	it.each([
		["gpt-5.5", true],
		["gpt-5.3-codex", true],
		["gpt-5.6-sol", true],
		["gpt-oss-120b", false],
		["gpt-4.1", false],
		["claude-opus-4-7", false],
		["gemini-3.7-flash", false],
		["o3-pro", false],
	])("%s -> %s", (id, expected) => {
		expect(usePatchForModel({ id, provider: "x" })).toBe(expected);
	});

	it("uses lune.applyPatch.models regexes when configured", () => {
		expect(usePatchForModel({ id: "claude-opus-4-7", provider: "anthropic" }, ["^anthropic/"])).toBe(true);
		expect(usePatchForModel({ id: "gpt-5.5", provider: "openai" }, ["^anthropic/"])).toBe(false);
		expect(usePatchForModel({ id: "gpt-5.5", provider: "openai" }, ["["])).toBe(false);
	});
});

describe("computeActiveTools", () => {
	const DEFAULT = ["read", "bash", "edit", "write", "apply_patch"];

	it("swaps edit/write for apply_patch and restores them on the way back", () => {
		const state: SwapState = {};
		const gpt = computeActiveTools(DEFAULT, true, state);
		expect(gpt).toEqual(["read", "bash", "apply_patch"]);
		expect(state.swapped).toEqual({ edit: true, write: true });

		const claude = computeActiveTools(gpt, false, state);
		expect(claude).toEqual(["read", "bash", "edit", "write"]);
		expect(state.swapped).toBeUndefined();
	});

	it("adds apply_patch when it was not active yet", () => {
		expect(computeActiveTools(["read", "bash", "edit", "write"], true, {})).toEqual(["read", "bash", "apply_patch"]);
	});

	it("removes apply_patch for non-GPT models without touching anything else", () => {
		expect(computeActiveTools(DEFAULT, false, {})).toEqual(["read", "bash", "edit", "write"]);
		expect(computeActiveTools(["read", "grep"], false, {})).toEqual(["read", "grep"]);
	});

	it("restores only the tools that were active before the swap", () => {
		const state: SwapState = {};
		const swapped = computeActiveTools(["read", "bash", "edit"], true, state);
		expect(swapped).toEqual(["read", "bash", "apply_patch"]);
		expect(computeActiveTools(swapped, false, state)).toEqual(["read", "bash", "edit"]);
	});

	it("does not grant apply_patch when editing was not allowed", () => {
		const state: SwapState = {};
		expect(computeActiveTools(["read", "bash", "apply_patch"], true, state)).toEqual(["read", "bash"]);
		expect(state.swapped).toBeUndefined();
	});

	it("is idempotent", () => {
		const state: SwapState = {};
		const once = computeActiveTools(DEFAULT, true, state);
		expect(computeActiveTools(once, true, state)).toEqual(once);
		const back = computeActiveTools(once, false, state);
		expect(computeActiveTools(back, false, state)).toEqual(back);
	});

	it("honours a restored swap state on a fresh tool set", () => {
		const state: SwapState = { swapped: { edit: true, write: false } };
		expect(computeActiveTools(["read", "bash", "edit", "write", "apply_patch"], false, state)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
		]);
	});
});
