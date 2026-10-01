import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { LITHOSAI_MODELS } from "./lithosai.models.ts";

export function lithosaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "lithosai",
		name: "LithosAI",
		baseUrl: "https://api.lithosai.cloud/v1",
		auth: { apiKey: envApiKeyAuth("LithosAI API key", ["LITHOS_AI_KEY", "LITHOSAI_API_KEY"]) },
		models: Object.values(LITHOSAI_MODELS),
		api: openAICompletionsApi(),
	});
}
