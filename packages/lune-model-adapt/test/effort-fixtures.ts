import type { Model } from "@earendil-works/pi-ai";

const model = (
	provider: string,
	id: string,
	thinkingLevelMap: Model<any>["thinkingLevelMap"],
	reasoning = true,
): Model<any> =>
	({
		id,
		provider,
		name: id,
		api: "openai-responses",
		reasoning,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 32000,
		thinkingLevelMap,
	}) as unknown as Model<any>;

/** Real thinkingLevelMap values from packages/ai/src/providers/data (Sep 2026). */
export const FIXTURES = {
	sol: model("openai", "gpt-5.6-sol", {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	}),
	gpt55: model("openai", "gpt-5.5", {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	}),
	codex: model("openai", "gpt-5.3-codex", {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	}),
	glm53: model("zai", "glm-5.3", {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	}),
	glm52: model("zai", "glm-5.2", {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	}),
	grok46: model("xai", "grok-4.6", {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	}),
	grok45: model("xai", "grok-4.5", {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	}),
	/** pi's catalog entry: only off/minimal nulled, so getSupportedThinkingLevels still yields low/medium/high. */
	grokBuild: model("xai", "grok-build-0.1", { off: null, minimal: null }),
	/** A model with no reasoning control at all. */
	noReasoning: model("xai", "grok-no-effort", undefined, false),
};
