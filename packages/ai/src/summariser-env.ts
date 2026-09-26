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
 * Reads directly from `process.env`. Required: `PI_SUMMARIZER_BASE_URL`,
 * `PI_SUMMARIZER_MODEL`, `PI_SUMMARIZER_API_KEY`.
 *
 * Returns `undefined` when no override is configured (silent fallback to the main model).
 * Returns `undefined` with a `console.warn` when any required var is missing or empty —
 * partial configs are surfaced loudly rather than silently dropping a half-configured override.
 */
export function resolveSummariserEnv(): SummariserEnvOverride | undefined {
	const baseUrl = getProviderEnvValue(PI_SUMMARIZER_BASE_URL_ENV)?.trim();
	const model = getProviderEnvValue(PI_SUMMARIZER_MODEL_ENV)?.trim();
	const apiKey = getProviderEnvValue(PI_SUMMARIZER_API_KEY_ENV)?.trim();

	if (!baseUrl && !model && !apiKey) return undefined;

	if (!baseUrl || !model || !apiKey) {
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

	return { model: model, baseUrl: baseUrl, apiKey: apiKey };
}
