import { resolveSummariserEnv } from "./summariser-env.ts";
import type { Model } from "./types.ts";

const SUMMARISER_DEFAULT_PROVIDER = "pi-summariser-override";
const SUMMARISER_DEFAULT_CONTEXT_WINDOW = 128000;
const SUMMARISER_DEFAULT_MAX_TOKENS = 8192;

/** Stable provider id used to register the override model on a `MutableModels` collection. */
export const SUMMARISER_OVERRIDE_PROVIDER_ID = SUMMARISER_DEFAULT_PROVIDER;

/** Resolved PI_SUMMARIZER_* override: a one-off model + the api key used to call it. */
export interface SummariserModelOverride {
	/** OpenAI-compatible model pointed at the override base URL. */
	model: Model<"openai-completions">;
	/** API key used to authenticate against the override endpoint. */
	apiKey: string;
}

/**
 * Resolve a Model<"openai-completions"> + API key that the summariser should use
 * when the `PI_SUMMARIZER_*` env-var override is configured.
 *
 * Reads directly from `process.env`. Returns `undefined` when no override is
 * configured (or only a partial set is present); callers should fall back to
 * the main agent model in that case.
 *
 * The returned model targets an OpenAI-compatible API at the configured base
 * URL so DeepSeek, vLLM, OpenRouter, llama.cpp, and similar proxies work
 * without per-provider plumbing. The caller is responsible for registering the
 * provider on a `MutableModels` before issuing any request.
 */
export function resolveSummariserModel(): SummariserModelOverride | undefined {
	const override = resolveSummariserEnv();
	if (!override) return undefined;

	const model: Model<"openai-completions"> = {
		id: override.model,
		name: `${override.model} (PI summariser override)`,
		api: "openai-completions",
		provider: SUMMARISER_DEFAULT_PROVIDER,
		baseUrl: override.baseUrl,
		reasoning: false,
		input: ["text"],
		// Cost unknown for arbitrary endpoints; zero is conservative so /usage
		// surfaces don't over-report spend on the override model.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: SUMMARISER_DEFAULT_CONTEXT_WINDOW,
		maxTokens: SUMMARISER_DEFAULT_MAX_TOKENS,
	};
	return { model, apiKey: override.apiKey };
}
