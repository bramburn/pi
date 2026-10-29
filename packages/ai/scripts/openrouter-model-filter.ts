/**
 * OpenRouter catalog entry filter used by fetchOpenRouterModels().
 *
 * OpenRouter's /api/v1/models `supported_parameters` drives which entries the
 * generator keeps. Router aliases and freshly-added models can resolve to
 * tool-capable models while their metadata has not listed "tools" yet —
 * `openrouter/fusion` is the documented case and is still injected as a
 * hardcoded entry in generate-models.ts because its live metadata (pricing -1,
 * no reasoning flag, default maxTokens) is unusable.
 *
 * OPENROUTER_TOOL_EXEMPT_MODEL_IDS is the allowlist for models in that state:
 * verified tool-capable on the live endpoint but missing "tools" in
 * `supported_parameters`. Never add an id on models.dev's word alone — check
 * the live entry first, because models.dev can claim `tool_call: true` for
 * models OpenRouter does not route tools for (cohere/command-a, verified
 * 2026-10-20: no endpoint advertises tools, tool_choice pinned to none).
 */
export const OPENROUTER_TOOL_EXEMPT_MODEL_IDS = new Set<string>();

/** Whether an OpenRouter /api/v1/models entry becomes a generated pi model. */
export function shouldIncludeOpenRouterModel(
	model: { readonly id: string; readonly supported_parameters?: string[] },
	exemptModelIds: ReadonlySet<string> = OPENROUTER_TOOL_EXEMPT_MODEL_IDS,
): boolean {
	if (exemptModelIds.has(model.id)) return true;
	return model.supported_parameters?.includes("tools") === true;
}
