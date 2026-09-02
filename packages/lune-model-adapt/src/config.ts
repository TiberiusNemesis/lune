/**
 * Extension configuration, stored under the `lune` key of pi's settings.json.
 *
 * Pi's SettingsManager only rewrites the fields it modified and merges into the current
 * file contents, so unknown top-level keys survive a load/save round-trip. The project
 * file overrides the global one with the same deep merge pi uses for its own settings.
 */

import { readFileSync } from "node:fs";
import type { EffortConfig } from "./effort/ladder.ts";

export interface LuneConfig {
	modelPrompts?: {
		/** Regex on `provider/id` -> family name or path to a markdown prompt. First match wins. */
		overrides?: Record<string, string>;
	};
	applyPatch?: {
		/** Regexes on `provider/id`. When set, replaces the built-in GPT rule. */
		models?: string[];
		/** Permit patches that touch files outside the working directory. Default: false. */
		allowOutsideWorkspace?: boolean;
	};
	/** Adaptive thinking-level policy (extensions/effort-policy.ts). */
	effort?: EffortConfig;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const current = result[key];
		result[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
	}
	return result;
}

/** Read the `lune` section of a settings file. Missing or invalid files yield `{}`. */
export function readLuneSection(settingsPath: string): Record<string, unknown> {
	try {
		const raw = readFileSync(settingsPath, "utf-8").replace(/^﻿/, "");
		const parsed: unknown = JSON.parse(raw);
		return isObject(parsed) && isObject(parsed.lune) ? parsed.lune : {};
	} catch {
		return {};
	}
}

export function loadLuneConfig(paths: { global: string; project?: string }): LuneConfig {
	const global = readLuneSection(paths.global);
	const project = paths.project ? readLuneSection(paths.project) : {};
	return deepMerge(global, project) as LuneConfig;
}
