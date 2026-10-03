// Test hermeticity: keep live-network blocks off unless explicitly requested.
//
// The provider test files in this package gate their live blocks on
// `describe.skipIf(!process.env.<PROVIDER>_API_KEY)`, which vitest evaluates at
// COLLECTION time. Vitest runs `setupFiles` before importing any test module, so
// deleting the credential env vars here makes every one of those blocks skip
// without touching the individual `skipIf` gates.
//
// Why this matters: a developer machine (or an agent) that runs vitest directly
// with provider keys exported would otherwise make real, billed API calls as a
// side effect of running a unit test file. `./test.sh` is already immune - it
// re-execs under `env -i` with an explicit allowlist, and CI calls that script -
// so the leak only reaches direct single-file runs, which is exactly how
// AGENTS.md tells developers to run one test file.
//
// Opt in with `PI_LIVE_TESTS=1` (also allowlisted in test.sh, so
// `PI_LIVE_TESTS=1 ./test.sh` works end to end).
//
// Two precedents this mirrors:
//   - packages/coding-agent/test/suite/harness.ts - module-load scrub of the
//     ambient PI_SUMMARIZER_* override, for the same "tests must not inherit the
//     developer's real endpoint/key" reason.
//   - packages/coding-agent/test/test-network-env.ts - offline-by-default with a
//     per-test opt-in (`allowNetwork()`).
//   - PI_OFFLINE is deliberately NOT used here: it is a product flag read only by
//     packages/coding-agent/src (tool downloads, version check, catalog refresh,
//     telemetry). Nothing in packages/ai reads it, so setting it would be a no-op.
//
// NOTE: this file is intentionally duplicated in packages/coding-agent/test/. The
// two vitest configs do not share a root base config, and a file outside every
// tsconfig include risks `tsgo` "file not in project" errors under `bun run check`.
// Update both copies together.

/** Env var that opts the whole package into live-network tests. */
const OPT_IN = "PI_LIVE_TESTS";

/** Credential env var suffixes that live blocks gate on. */
const CREDENTIAL_SUFFIXES = ["_API_KEY", "_OAUTH_TOKEN"] as const;

/**
 * Live-block gates that do not match {@link CREDENTIAL_SUFFIXES}. `HF_TOKEN` is
 * the only one today; add any new non-conforming provider here, otherwise its
 * live block will keep auto-activating from the ambient environment.
 */
const EXTRA_CREDENTIALS = ["HF_TOKEN"] as const;

// Deliberately narrow: AWS_* , GOOGLE_APPLICATION_CREDENTIALS, HF_HOME and other
// non-credential-shaped vars are left alone. Tests such as
// bedrock-endpoint-resolution.test.ts and baseten-models.test.ts manage those
// themselves in beforeEach/afterAll and assert on ambient-preservation behaviour.
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
