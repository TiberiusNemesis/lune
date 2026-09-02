import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLuneConfig, readLuneSection } from "../src/config.ts";

describe("loadLuneConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "lune-config-"));
	const global = join(dir, "global.json");
	const project = join(dir, "project.json");
	writeFileSync(
		global,
		JSON.stringify({
			theme: "dark",
			lune: {
				modelPrompts: { overrides: { "^openai/": "gpt" } },
				applyPatch: { models: ["^openai/"], allowOutsideWorkspace: true },
			},
		}),
	);
	writeFileSync(
		project,
		`﻿${JSON.stringify({ lune: { modelPrompts: { overrides: { "^anthropic/": "kimi" } }, applyPatch: { models: ["^x/"] } } })}`,
	);

	it("merges project over global like pi's settings (objects merge, arrays replace)", () => {
		expect(loadLuneConfig({ global, project })).toEqual({
			modelPrompts: { overrides: { "^openai/": "gpt", "^anthropic/": "kimi" } },
			applyPatch: { models: ["^x/"], allowOutsideWorkspace: true },
		});
	});

	it("ignores missing or invalid files", () => {
		expect(loadLuneConfig({ global: join(dir, "missing.json") })).toEqual({});
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{ not json");
		expect(readLuneSection(broken)).toEqual({});
	});
});
