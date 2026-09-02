/**
 * Prompt -> phase classifier. Heuristic only; `PromptClassifier` is the hook point for a
 * small-model classifier later.
 */

export type Phase = "investigate" | "mechanical" | "baseline";

export interface ClassifierOptions {
	investigateKeywords?: string[];
	mechanicalKeywords?: string[];
	/** Prompts longer than this open at ceiling. Default: 80. */
	longPromptWords?: number;
	/** Mechanical prompts must be at most this long. Default: 30. */
	shortPromptWords?: number;
}

export type PromptClassifier = (prompt: string) => Phase;

export const DEFAULT_INVESTIGATE_KEYWORDS = [
	"design",
	"architecture",
	"why",
	"investigate",
	"debug",
	"root cause",
	"refactor",
	"plan",
	"migrate",
];

export const DEFAULT_MECHANICAL_KEYWORDS = [
	"rename",
	"bump",
	"typo",
	"add a test for",
	"update copy",
	"format",
	"lint fix",
];

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matches(text: string, keywords: string[]): string | undefined {
	return keywords.find((keyword) => new RegExp(`\\b${escapeRegex(keyword.toLowerCase())}`).test(text));
}

export interface Classification {
	phase: Phase;
	/** What decided it: "long", a matched keyword, or "default". */
	because: string;
}

export function classifyPrompt(prompt: string, options: ClassifierOptions = {}): Classification {
	const words = countWords(prompt);
	const text = prompt.toLowerCase();
	const long = options.longPromptWords ?? 80;
	const short = options.shortPromptWords ?? 30;
	const investigate = [...DEFAULT_INVESTIGATE_KEYWORDS, ...(options.investigateKeywords ?? [])];
	const mechanical = [...DEFAULT_MECHANICAL_KEYWORDS, ...(options.mechanicalKeywords ?? [])];

	if (words > long) return { phase: "investigate", because: `${words} words` };
	const investigateHit = matches(text, investigate);
	if (investigateHit) return { phase: "investigate", because: investigateHit };
	const mechanicalHit = words <= short ? matches(text, mechanical) : undefined;
	if (mechanicalHit) return { phase: "mechanical", because: mechanicalHit };
	return { phase: "baseline", because: "default" };
}
