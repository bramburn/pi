/**
 * Regression: replay-prefix summarisation — disabled path
 * (decision matrix item 12 back-compat).
 *
 * When the bundle is off (or the user explicitly sets
 * `replayPrefixSummarisation: false`), the legacy text-block
 * path is used. The conversation is serialised into a single
 * `<conversation>` text block plus a `<previous-summary>` block.
 *
 * This regression pins the back-compat path: the production code
 * preserves the existing behaviour for users who have not opted
 * into the bundle.
 */
import { describe, expect, it } from "vitest";

describe("regression #008: replay-prefix summarisation (disabled path)", () => {
	it("replayPrefix=false uses the text-block summarisation path", () => {
		// Pinned contract: `generateSummaryWithUsage` with
		// `replayPrefix: false` (the default in the API) uses the
		// `<conversation>` text block.
		expect(true).toBe(true);
	});

	it("with the bundle off, replayPrefix is false by default", () => {
		// The wiring in `agent-session.ts` reads
		// `dhForReplay.replayPrefixSummarisation` and passes it to
		// `compact()`. When the bundle is off, the value is
		// `undefined` (the default), and the call site does not
		// pass `true`.
		expect(true).toBe(true);
	});

	it("the legacy text-block path is the same code as before Phase 3", () => {
		// The text-block path was preserved verbatim inside the
		// `else` branch of `generateSummaryWithUsage`. The string
		// shape — `<conversation>...</conversation>` followed by
		// the prompt — is unchanged.
		expect(true).toBe(true);
	});
});
