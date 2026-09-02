import { describe, expect, it } from "vitest";
import { classifyPrompt } from "../src/effort/classify.ts";
import { resolveLadder, stepDown, stepUp } from "../src/effort/ladder.ts";
import { FIXTURES } from "./effort-fixtures.ts";

describe("resolveLadder", () => {
	it("ships the documented defaults, clamped to each model's levels", () => {
		const table = Object.fromEntries(
			Object.entries(FIXTURES).map(([key, model]) => {
				const r = resolveLadder(model);
				return [
					key,
					r.active
						? `${r.ladder.levels.join(",")} | ${r.ladder.floor} ${r.ladder.baseline} ${r.ladder.ceiling} ${r.ladder.rescue ?? "-"}`
						: `inactive: ${r.reason}`,
				];
			}),
		);
		expect(table).toEqual({
			sol: "low,medium,high,xhigh,max | low medium high xhigh",
			gpt55: "low,medium,high,xhigh | low medium high xhigh",
			codex: "low,medium,high,xhigh | low high xhigh -",
			glm53: "low,high,max | low high max -",
			glm52: "high,max | high high max -",
			grok46: "low,medium,high,xhigh | low high xhigh -",
			grok45: "low,medium,high | low high high -",
			grokBuild: "inactive: disabled for /grok-build/",
			noReasoning: "inactive: model exposes 0 usable level(s)",
		});
	});

	it("does not treat the openai-codex provider as a codex model", () => {
		const r = resolveLadder({ ...FIXTURES.sol, provider: "openai-codex" });
		expect(r.active && r.ladder).toMatchObject({ baseline: "medium", ceiling: "high", rescue: "xhigh" });
		const codex = resolveLadder({ ...FIXTURES.codex, provider: "openai-codex" });
		expect(codex.active && codex.ladder.source).toBe("/[^/]*codex");
	});

	it("honours user overrides before the built-in table and drops rescue when it cannot exceed ceiling", () => {
		const r = resolveLadder(FIXTURES.sol, {
			models: { "^openai/gpt-5\\.6-sol$": { baseline: "low", ceiling: "max", rescue: "max" } },
		});
		expect(r.active && r.ladder).toMatchObject({
			baseline: "low",
			ceiling: "max",
			rescue: undefined,
			source: "^openai/gpt-5\\.6-sol$",
		});
		const disabled = resolveLadder(FIXTURES.sol, { models: { sol: { enabled: false } } });
		expect(disabled).toEqual({ active: false, reason: "disabled for /sol/" });
		expect(resolveLadder(FIXTURES.sol, { enabled: false }).active).toBe(false);
	});

	it("keeps off on the ladder only when allowOff is set", () => {
		const r = resolveLadder(FIXTURES.glm52, { allowOff: true });
		expect(r.active && r.ladder.levels).toEqual(["off", "high", "max"]);
		expect(r.active && r.ladder.floor).toBe("off");
	});

	it("steps through the model's available levels", () => {
		expect(stepUp(["low", "high", "max"], "high")).toBe("max");
		expect(stepUp(["low", "high", "max"], "max")).toBe("max");
		expect(stepDown(["low", "high", "max"], "high")).toBe("low");
		expect(stepDown(["low", "high", "max"], "low")).toBe("low");
	});
});

describe("classifyPrompt", () => {
	const cases: Array<[string, string]> = [
		["Investigate why the login test is flaky", "investigate"],
		["Debug the crash on startup", "investigate"],
		["What is the root cause of the memory leak?", "investigate"],
		["Refactor the session manager into smaller modules", "investigate"],
		["Plan the migration to the new storage backend", "investigate"],
		["Design an API for plugins", "investigate"],
		[`Add caching. ${"word ".repeat(85)}`, "investigate"],
		["Rename foo to bar", "mechanical"],
		["Bump vitest to 4.1.9", "mechanical"],
		["Fix the typo in README", "mechanical"],
		["Add a test for parseArgs", "mechanical"],
		["Format the src directory", "mechanical"],
		["Update copy on the landing page", "mechanical"],
		["Add a dark mode toggle to the settings page", "baseline"],
		["Create a file hello.txt containing hello", "baseline"],
		[`Rename foo to bar. ${"and also this ".repeat(12)}`, "baseline"],
		["Why does this format?", "investigate"],
	];
	it.each(cases)("%s → %s", (prompt, phase) => {
		expect(classifyPrompt(prompt).phase).toBe(phase);
	});

	it("extends the keyword lists from config", () => {
		expect(classifyPrompt("Untangle the scheduler", { investigateKeywords: ["untangle"] }).phase).toBe("investigate");
		expect(classifyPrompt("Regenerate snapshots", { mechanicalKeywords: ["regenerate"] }).phase).toBe("mechanical");
		expect(classifyPrompt("Regenerate snapshots").phase).toBe("baseline");
	});
});
