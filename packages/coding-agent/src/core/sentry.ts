/**
 * Sentry telemetry wiring for the coding-agent CLI.
 *
 * Initialize the official `@sentry/node` SDK when the user opts in via
 * `PI_AI_DEBUG=1` and supplies a `SENTRY_DSN`. Both variables are required;
 * either alone is a no-op so dev/CI never silently phones home without an
 * explicit destination.
 *
 * The handle returned by {@link initSentryIfEnabled} installs process-level
 * listeners that forward uncaught exceptions, unhandled rejections, and
 * process warnings into Sentry. {@link SentryContextHandle.dispose} flushes
 * pending events on process exit.
 */

import * as Sentry from "@sentry/node";
import { APP_NAME, VERSION } from "../config.ts";

/** Process-wide Sentry handle. Created by {@link initSentryIfEnabled}. */
export interface SentryContextHandle {
	readonly dsn: string;
	readonly release: string;
	readonly environment: string;
	dispose(): Promise<void>;
}

const SENTRY_RELEASE = `${APP_NAME}-coding-agent@${VERSION}`;

/**
 * Returns true when the user has opted in to Sentry via `PI_AI_DEBUG=1` and
 * provided a `SENTRY_DSN`. Both must be present; either alone is a no-op.
 */
export function isSentryDebugEnabled(): boolean {
	return isTruthyEnvFlag(process.env.PI_AI_DEBUG) && hasSentryDsn();
}

function hasSentryDsn(): boolean {
	const dsn = process.env.SENTRY_DSN;
	return typeof dsn === "string" && dsn.trim().length > 0;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function detectEnvironment(): string {
	if (process.env.NODE_ENV) return process.env.NODE_ENV;
	if (process.env.PI_ENVIRONMENT) return process.env.PI_ENVIRONMENT;
	return "development";
}

function parseSampleRate(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseFloat(value);
	if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) return fallback;
	return parsed;
}

/**
 * Creates a Sentry context when the user opts in via `PI_AI_DEBUG=1` and a
 * `SENTRY_DSN` is configured. Returns `undefined` otherwise.
 *
 * The returned handle also installs process-level handlers that capture
 * uncaught exceptions, unhandled rejections, and warning-level events, then
 * flush the Sentry queue on disposal.
 */
export function initSentryIfEnabled(): SentryContextHandle | undefined {
	if (!isSentryDebugEnabled()) return undefined;
	const dsn = process.env.SENTRY_DSN;
	if (!dsn) return undefined;
	const environment = detectEnvironment();
	const tracesSampleRate = parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);

	Sentry.init({
		dsn,
		release: SENTRY_RELEASE,
		environment,
		tracesSampleRate,
		// Keep the agent quiet on stdout; users opt in via PI_AI_DEBUG, not
		// because they want Sentry to spam their terminal.
		debug: false,
	});

	const onUncaught = (error: Error): void => {
		Sentry.captureException(error, { tags: { source: "uncaughtException" } });
	};
	const onUnhandled = (reason: unknown): void => {
		const error = reason instanceof Error ? reason : new Error(String(reason));
		Sentry.captureException(error, { tags: { source: "unhandledRejection" } });
	};
	const onWarning = (warning: Error): void => {
		Sentry.captureException(warning, { tags: { source: "warning" } });
	};
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUnhandled);
	process.on("warning", onWarning);

	const handle: SentryContextHandle = {
		dsn,
		release: SENTRY_RELEASE,
		environment,
		async dispose() {
			try {
				await Sentry.close(2_000);
			} catch {
				// Best-effort flush; never throw from disposal.
			}
		},
	};
	return handle;
}
