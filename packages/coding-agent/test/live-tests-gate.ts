// Test hermeticity: keep live-network blocks off unless explicitly requested.
//
// This package has two live-network blocks that gate on ambient credentials:
//   - test/compaction.test.ts  "LLM summarization" (ANTHROPIC_OAUTH_TOKEN)
//   - test/rpc.test.ts         "RPC mode" (ANTHROPIC_API_KEY || ANTHROPIC_OAUTH_TOKEN)
// Vitest evaluates those `describe.skipIf(...)` conditions at COLLECTION time and
// runs `setupFiles` before importing any test module, so deleting the credential
// env vars here makes both blocks skip without touching the individual gates.
//
// Why this matters: a developer machine (or an agent) that runs vitest directly
// with an Anthropic key exported would otherwise make real, billed API calls - and
// rpc.test.ts spawns a full pi session - as a side effect of running a unit test.
// `./test.sh` is already immune (it re-execs under `env -i` with an allowlist) and
// CI calls that script, so the leak only reaches direct single-file runs, which is
// how AGENTS.md tells developers to run one test file.
//
// Opt in with `PI_LIVE_TESTS=1` (also allowlisted in test.sh).
//
// This is the same shape as the offline-by-default convention this package already
// uses for source-level network calls: `env: { PI_OFFLINE: "1" }` in
// vitest.config.ts plus allowNetwork() in test/test-network-env.ts. Those tests
// reach the network deliberately, so they keep gating on their own credentials.
//
// NOTE: this file is intentionally duplicated in packages/ai/test/, which carries
// the bulk of the repo's live blocks. The two vitest configs do not share a root
// base config, and a file outside every tsconfig include risks `tsgo`
// "file not in project" errors under `bun run check`. Update both copies together.

/** Env var that opts the whole package into live-network tests. */
const OPT_IN = "PI_LIVE_TESTS";

/** Credential env var suffixes that live blocks gate on. */
const CREDENTIAL_SUFFIXES = ["_API_KEY", "_OAUTH_TOKEN"] as const;

/**
 * Live-block gates that do not match {@link CREDENTIAL_SUFFIXES}. Empty here:
 * both blocks above use the suffixes. Add any new non-conforming provider here,
 * otherwise its live block will keep auto-activating from the ambient environment.
 */
const EXTRA_CREDENTIALS = [] as const;

// Deliberately narrow: AWS_* and other non-credential-shaped vars are left alone.
// bedrock-endpoint-resolution.test.ts and baseten-models.test.ts manage those
// themselves and assert on ambient-preservation behaviour.
if (process.env[OPT_IN] !== "1") {
	for (const key of Object.keys(process.env)) {
		if (EXTRA_CREDENTIALS.includes(key as (typeof EXTRA_CREDENTIALS)[number])) {
			delete process.env[key];
			continue;
		}
		if (CREDENTIAL_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
			delete process.env[key];
		}
	}
}
