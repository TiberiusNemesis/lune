/**
 * Per-model effort ladder: which thinking levels the policy may move between, and where
 * baseline / ceiling / rescue sit on that ladder. Levels are derived from the model at
 * runtime via getSupportedThinkingLevels; nothing is hardcoded per model except the
 * baseline/ceiling table, which is itself clamped to what the model supports.
 */

import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export const LEVEL_ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelEffortEntry {
	baseline?: ModelThinkingLevel;
	ceiling?: ModelThinkingLevel;
	/** One step above ceiling, reachable only by the failure ladder. */
	rescue?: ModelThinkingLevel;
	/** `false` disables the policy for matching models. */
	enabled?: boolean;
}

export interface EffortConfig {
	/** Master switch. Default: true. */
	enabled?: boolean;
	/** Keep `off` on the ladder. Default: false (agentic turns never run at `none`). */
	allowOff?: boolean;
	/** Regex on `provider/id` -> ladder entry. Checked before the built-in table; first match wins. */
	models?: Record<string, ModelEffortEntry>;
	/** Extra prompt-classifier keywords, appended to the built-in lists. */
	keywords?: { investigate?: string[]; mechanical?: string[] };
	/** Prompts longer than this many words open at ceiling. Default: 80. */
	longPromptWords?: number;
	/** Mechanical prompts must be at most this many words. Default: 30. */
	shortPromptWords?: number;
	/** Regexes on bash output that mark a turn as failed. Replaces the built-in list. */
	testFailurePatterns?: string[];
	/** Per-run budget. Crossing any cap pins effort at floor for the rest of the run. */
	budget?: Budget;
	/** Context-usage guards, in percent. Defaults: 70 / 85. */
	context?: { baselineAbove?: number; floorAbove?: number };
}

export interface Budget {
	costUsd?: number;
	/** Output tokens, which already include reasoning tokens. */
	outputTokens?: number;
	wallClockMinutes?: number;
}

/**
 * Built-in table, matched against `provider/id`. Order matters: first match wins.
 * Sources: Artificial Analysis Coding Agent Index (Sep 2026) for the GPT-5.6 family; provider docs
 * for the level sets (see README).
 */
export const DEFAULT_MODEL_TABLE: ReadonlyArray<readonly [pattern: string, entry: ModelEffortEntry]> = [
	// xAI rejects explicit effort on grok-build; pi's catalog still lists low/medium/high for it.
	["grok-build", { enabled: false }],
	["gpt-5\\.6-(luna|terra|mini|nano)", { baseline: "high", ceiling: "xhigh", rescue: "max" }],
	// Anchored past the slash so the `openai-codex` provider name does not match.
	["/[^/]*codex", { baseline: "high", ceiling: "xhigh", rescue: "max" }],
	["gpt-5\\.5$|gpt-5\\.6(-sol)?$", { baseline: "medium", ceiling: "high", rescue: "xhigh" }],
	["grok-4\\.6", { baseline: "high", ceiling: "xhigh" }],
	["grok-4\\.5", { baseline: "high", ceiling: "high" }],
	["glm-5\\.3", { baseline: "high", ceiling: "max" }],
	["glm-5\\.2", { baseline: "high", ceiling: "max" }],
];

const FALLBACK_ENTRY: ModelEffortEntry = { baseline: "medium", ceiling: "high" };

export interface Ladder {
	levels: ModelThinkingLevel[];
	floor: ModelThinkingLevel;
	baseline: ModelThinkingLevel;
	ceiling: ModelThinkingLevel;
	rescue?: ModelThinkingLevel;
	/** Table pattern that produced the entry, or "fallback". */
	source: string;
}

export type LadderResolution = { active: true; ladder: Ladder } | { active: false; reason: string };

export const rank = (level: ModelThinkingLevel): number => LEVEL_ORDER.indexOf(level);

export const minLevel = (a: ModelThinkingLevel, b: ModelThinkingLevel): ModelThinkingLevel =>
	rank(a) <= rank(b) ? a : b;

/** Nearest supported level: the requested one, else the next one up, else the next one down (pi's rule). */
export function clampToLevels(levels: ModelThinkingLevel[], level: ModelThinkingLevel): ModelThinkingLevel {
	if (levels.includes(level)) return level;
	const requested = rank(level);
	for (let i = requested + 1; i < LEVEL_ORDER.length; i++) if (levels.includes(LEVEL_ORDER[i])) return LEVEL_ORDER[i];
	for (let i = requested - 1; i >= 0; i--) if (levels.includes(LEVEL_ORDER[i])) return LEVEL_ORDER[i];
	return levels[0];
}

/** Next available level above `level`, or `level` itself at the top. */
export function stepUp(levels: ModelThinkingLevel[], level: ModelThinkingLevel): ModelThinkingLevel {
	const i = levels.indexOf(level);
	return i >= 0 && i < levels.length - 1 ? levels[i + 1] : clampToLevels(levels, level);
}

/** Next available level below `level`, or `level` itself at the bottom. */
export function stepDown(levels: ModelThinkingLevel[], level: ModelThinkingLevel): ModelThinkingLevel {
	const i = levels.indexOf(level);
	return i > 0 ? levels[i - 1] : clampToLevels(levels, level);
}

export function findModelEntry(
	key: string,
	overrides?: Record<string, ModelEffortEntry>,
): { pattern: string; entry: ModelEffortEntry } | undefined {
	const candidates: Array<readonly [string, ModelEffortEntry]> = [
		...Object.entries(overrides ?? {}),
		...DEFAULT_MODEL_TABLE,
	];
	for (const [pattern, entry] of candidates) {
		try {
			if (new RegExp(pattern).test(key)) return { pattern, entry };
		} catch {
			// Invalid user regex: skip it.
		}
	}
	return undefined;
}

export function resolveLadder(
	model: Pick<Model<any>, "provider" | "id" | "reasoning" | "thinkingLevelMap">,
	config: Pick<EffortConfig, "models" | "allowOff" | "enabled"> = {},
): LadderResolution {
	if (config.enabled === false) return { active: false, reason: "disabled in lune.effort.enabled" };
	const key = `${model.provider}/${model.id}`;
	const match = findModelEntry(key, config.models);
	if (match?.entry.enabled === false) return { active: false, reason: `disabled for /${match.pattern}/` };

	const levels = getSupportedThinkingLevels(model as Model<any>).filter((level) => config.allowOff || level !== "off");
	if (levels.length < 2) return { active: false, reason: `model exposes ${levels.length} usable level(s)` };

	const entry = match?.entry ?? FALLBACK_ENTRY;
	const baseline = clampToLevels(levels, entry.baseline ?? FALLBACK_ENTRY.baseline!);
	const ceilingRaw = clampToLevels(levels, entry.ceiling ?? FALLBACK_ENTRY.ceiling!);
	const ceiling = rank(ceilingRaw) < rank(baseline) ? baseline : ceilingRaw;
	const rescueRaw = entry.rescue ? clampToLevels(levels, entry.rescue) : undefined;
	const rescue = rescueRaw && rank(rescueRaw) > rank(ceiling) ? rescueRaw : undefined;
	return {
		active: true,
		ladder: { levels, floor: levels[0], baseline, ceiling, rescue, source: match?.pattern ?? "fallback" },
	};
}
