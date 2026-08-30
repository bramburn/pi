/**
 * Live smoke test: initialize the real @sentry/node SDK against the user's
 * Sentry DSN, capture an exception, and flush. Run on demand only; this test
 * sends real network traffic to Sentry and is not part of the regular suite.
 *
 * Trigger with:
 *   PI_SENTRY_LIVE_TEST=1 npx vitest --run test/sentry-live.test.ts
 */

import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DSN = "https://ce4375001b5f9080e931d2c820cce432@o4511824802414592.ingest.us.sentry.io/4511824803528704";

const isEnabled = process.env.PI_SENTRY_LIVE_TEST === "1";

(isEnabled ? describe : describe.skip)("Live Sentry integration (PI_SENTRY_LIVE_TEST=1)", () => {
	beforeAll(() => {
		Sentry.init({
			dsn: DSN,
			release: "pi-coding-agent@0.84.4-live-test",
			environment: "live-smoke-test",
			tracesSampleRate: 0,
		});
	});

	afterAll(async () => {
		await Sentry.close(5_000);
	});

	it("ships a real event to the user-supplied Sentry DSN", async () => {
		const eventId = Sentry.captureException(new Error("Live test from pi-coding-agent Sentry integration"));
		expect(eventId).toMatch(/^[0-9a-f]{32}$/);
	});
});
