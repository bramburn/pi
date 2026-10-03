// =============================================================================
// PI_SUMMARIZER_* override — build the Model<"openai-completions"> to register
// =============================================================================
//
// This module is the second half of the override flow (the first is
// summariser-env.ts). It consumes the env-resolved {@link SummariserEnvOverride}
// and produces a `Model<"openai-completions">` that the host can drop onto a
// `MutableModels` collection and then call like any other model.
//
// Why a separate module and not just one big `resolveSummariserOverride()`
// function? Splitting env-var discovery (`summariser-env.ts`) from model-shape
// construction (`summariser-model.ts`) keeps each piece unit-testable in
// isolation: the env layer can be tested without constructing fake models,
// and the model layer can be tested without manipulating `process.env`.
// =============================================================================

import { resolveSummariserEnv } from "./summariser-env.ts";
import type { Model } from "./types.ts";

/**
 * Internal provider id shared with `agent-session.ts`. The host's wiring code
 * uses this to register the override on a `MutableModels` collection; the
 * returned model also carries it on its `.provider` field so auth resolution
 * (`Models.getAuth(model)` → `MutableModels.getProvider(model.provider)`)
 * finds the right provider. Both values must match — that's the contract
 * {@link SUMMARISER_OVERRIDE_PROVIDER_ID} enforces.
 */
const SUMMARISER_DEFAULT_PROVIDER = "pi-summariser-override";

/**
 * Fallback context window for the override model. The user's chosen endpoint
 * may actually accept more or less, but 128k is a safe upper bound for any
 * realistic summarisation workload (compaction never consumes more than the
 * agent's full context, which is usually 128k–1M). When in doubt, over-report
 * rather than under-report so /token-budget gauges don't prematurely bail.
 * Override per endpoint with `PI_SUMMARIZER_CONTEXT_WINDOW`
 * (see `resolveSummariserEnv`).
 */
const SUMMARISER_DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Fallback per-request max-output tokens. 8192 covers any reasonable
 * summarisation output (compaction summaries are typically 1–4k tokens). If
 * the user's chosen endpoint accepts more, fine — it's a soft cap.
 */
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
 * Resolve a `Model<"openai-completions">` + API key that the summariser should use
 * when the `PI_SUMMARIZER_*` env-var override is configured.
 *
 * Reads directly from `process.env` (via {@link resolveSummariserEnv}, which
 * already produces a partial-config warning). Returns `undefined` when no
 * override is configured (or only a partial set is present); callers should
 * fall back to the main agent model in that case.
 *
 * The returned model targets an OpenAI-compatible chat-completions API at the
 * configured base URL — DeepSeek, vLLM, OpenRouter, llama.cpp, and similar
 * proxies all work without per-provider plumbing. We pick `openai-completions`
 * rather than anthropic-messages / google-generative-ai / etc. because it is
 * the only API whose request shape is universally emulated by cheap-model
 * providers; Anthropic-style and Google-style message formats would force
 * per-provider plumbing (each provider has a different request envelope).
 *
 * **Caller responsibilities**: the host (`agent-session.ts`) is responsible
 * for (a) wrapping this model in a `Provider`, (b) registering the provider
 * on the `MutableModels`, and (c) calling `ModelRuntime.getAuth(model)`
 * which looks up the provider by `model.provider` — which is why that field
 * has to match the registered provider's id.
 *
 * @returns `{ model, apiKey }` if the override is configured; `undefined`
 *          otherwise (callers fall back to the main agent model).
 */
export function resolveSummariserModel(): SummariserModelOverride | undefined {
	const override = resolveSummariserEnv();
	if (!override) return undefined;

	const model: Model<"openai-completions"> = {
		// The user's chosen identifier at the override endpoint. Whatever they
		// set in PI_SUMMARIZER_MODEL — "deepseek-chat", "llama-3.1-8b", etc.
		id: override.model,
		// Surface name for UIs that list available models. The "(PI summariser
		// override)" suffix signals to the user that this isn't a normal model
		// in the agent's catalog.
		name: `${override.model} (PI summariser override)`,
		// Force OpenAI-compatible chat-completions. See the function-level
		// doc for why this is the universal choice for cheap-model proxies.
		api: "openai-completions",
		// Crucial: this MUST equal SUMMARISER_OVERRIDE_PROVIDER_ID, because
		// Models.getAuth() finds the registered provider via this field.
		provider: SUMMARISER_DEFAULT_PROVIDER,
		baseUrl: override.baseUrl,
		// Reasoning is explicitly off: the override endpoint is unknown to pi's
		// catalog, so we can't trust its reasoning mode. Disable to keep the
		// request shape simple and predictable across providers.
		reasoning: false,
		// Summarisation accepts plain text only. Images/tool_calls would require
		// a different request shape that not all OpenAI-compatible proxies support.
		input: ["text"],
		// Cost unknown for arbitrary endpoints. Reporting zero is conservative
		// (so /usage doesn't over-report spend on the override model); the user
		// understands the cost is invisible to pi's accounting.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// PI_SUMMARIZER_CONTEXT_WINDOW when it parsed as a positive integer,
		// otherwise the 128k fallback above.
		contextWindow: override.contextWindow ?? SUMMARISER_DEFAULT_CONTEXT_WINDOW,
		maxTokens: SUMMARISER_DEFAULT_MAX_TOKENS,
	};
	return { model, apiKey: override.apiKey };
}
