import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

const LITHOS_DEEPSEEK_V4_FLASH_MODELS = [
	{ id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
	{ id: "deepseek-ai/DeepSeek-V4.1-Flash-fast", name: "DeepSeek V4.1 Flash Fast" },
	{ id: "deepseek-ai/DeepSeek-V4.1-Flash-ultra", name: "DeepSeek V4.1 Flash Ultra" },
] as const;

describe("LithosAI models", () => {
	it("serves DeepSeek V4.1 Flash speed SKUs on the Lithos Chat Completions endpoint", () => {
		for (const { id, name } of LITHOS_DEEPSEEK_V4_FLASH_MODELS) {
			const model = getModel("lithosai", id);
			expect(model).toMatchObject({
				id,
				name,
				provider: "lithosai",
				api: "openai-completions",
				baseUrl: "https://api.lithosai.cloud/v1",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1048576,
				maxTokens: 384000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				thinkingLevelMap: {
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					max: "max",
				},
			});
			expect(model?.compat).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "deepseek",
				supportsLongCacheRetention: false,
			});
		}
	});
});
