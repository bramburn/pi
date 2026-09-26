// =============================================================================
// PI_SUMMARIZER_* env override — context-summarisation model routing
// =============================================================================
//
// Motivation: manual `/compact`, auto-compaction, and branch summary all run
// against whatever model the agent uses by default. For long sessions this is
// wasteful — summarisation is a cheap, well-suited-for-cheap-model task, while
// the main agent often runs an expensive frontier model. Routing the summary
// through a separate (typically cheaper) model is a 10x+ cost win with no
// quality regression on the agent loop itself.
//
// Three env vars route the summary through any OpenAI-compatible endpoint
// (DeepSeek, OpenRouter, vLLM, llama.cpp, ...). All three must be present;
// partial configs are warned about loudly rather than silently half-applying,
// because a partial override that defaults to the main model in production is
// worse than falling back visibly during local dev.
//
// `resolveSummariserEnv` is the env-var discovery step. It returns either a
// fully-populated {@link SummariserEnvOverride} (caller should use it) or
// `undefined` (caller should fall back to the main agent model).
// =============================================================================

import { getProviderEnvValue } from "./utils/provider-env.ts";

/** Required: base URL for an OpenAI-compatible summarisation endpoint. */
export const PI_SUMMARIZER_BASE_URL_ENV = "PI_SUMMARIZER_BASE_URL";
/** Required: model identifier passed to the override endpoint (e.g. "deepseek-chat"). */
export const PI_SUMMARIZER_MODEL_ENV = "PI_SUMMARIZER_MODEL";
/** Required: API key for the override endpoint. */
export const PI_SUMMARIZER_API_KEY_ENV = "PI_SUMMARIZER_API_KEY";

/** Resolved env-var override that routes context summarisation to a separate model. */
export interface SummariserEnvOverride {
	/** Model identifier passed to the override provider. */
	model: string;
	/** Base URL for an OpenAI-compatible API endpoint. */
	baseUrl: string;
	/** API key for the override endpoint. */
	apiKey: string;
}

/**
 * Resolve the {@link PI_SUMMARIZER_BASE_URL_ENV} / {@link PI_SUMMARIZER_MODEL_ENV} /
 * {@link PI_SUMMARIZER_API_KEY_ENV} override for context summarisation.
 *
 * Reads directly from `process.env` (via {@link getProviderEnvValue}). There is no
 * `ProviderEnv` parameter — the override is process-level by design, kept simple
 * so users can flip it on for a session via shell export and not have to wire
 * it through any session-config plumbing.
 *
 * Required: `PI_SUMMARIZER_BASE_URL`, `PI_SUMMARIZER_MODEL`, `PI_SUMMARIZER_API_KEY`
 * — all three. Whitespace-only values (e.g. `PI_SUMMARIZER_API_KEY=" "`) are trimmed
 * and treated as missing, on the assumption that the user's intent was empty.
 *
 * @returns
 *   - `undefined` when no override is configured (silent fallback to the main model).
 *     The "silent" path is intentional: users who never set the env vars should not
 *     see noise on every summarisation call.
 *   - `undefined` with a `console.warn` when at least one var is set but the set
 *     is incomplete. Partial configs are surfaced loudly because a half-configured
 *     override that then falls back to the main model in production is worse than
 *     failing visibly during local dev.
 *   - A populated {@link SummariserEnvOverride} when all three are set.
 */
export function resolveSummariserEnv(): SummariserEnvOverride | undefined {
	// Trim each value first so whitespace-only entries (e.g. accidental shell
	// export with `" "`) don't sneak through as a valid override.
	const baseUrl = getProviderEnvValue(PI_SUMMARIZER_BASE_URL_ENV)?.trim();
	const model = getProviderEnvValue(PI_SUMMARIZER_MODEL_ENV)?.trim();
	const apiKey = getProviderEnvValue(PI_SUMMARIZER_API_KEY_ENV)?.trim();

	// All three unset → caller falls back to the main model, no warning.
	// This is the "user didn't ask for an override" path and must be a hot path.
	if (!baseUrl && !model && !apiKey) return undefined;

	// At least one was set but not all three → partial config. Warn and fall back
	// rather than silently dropping half a config.
	if (!baseUrl || !model || !apiKey) {
		// Build the list of missing var names so the warning is actionable —
		// the user can see exactly which env var to set next.
		const missing = [
			!baseUrl && PI_SUMMARIZER_BASE_URL_ENV,
			!model && PI_SUMMARIZER_MODEL_ENV,
			!apiKey && PI_SUMMARIZER_API_KEY_ENV,
		].filter((name): name is string => !!name);
		console.warn(
			`[pi] PI_SUMMARIZER_* override is incomplete (missing: ${missing.join(", ")}). ` +
				"Falling back to the main model for context summarisation.",
		);
		return undefined;
	}

	// All three present and non-empty — return the override for the caller to consume.
	return { model: model, baseUrl: baseUrl, apiKey: apiKey };
}
