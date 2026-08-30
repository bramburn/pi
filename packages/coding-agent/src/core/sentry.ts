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
 *
 * Application code that wants to surface non-fatal failures (e.g. provider
 * HTTP errors that the agent catches and re-encodes as a stream event with
 * `stopReason: "error"`) should call {@link reportProviderError}, which is a
 * no-op when Sentry is not initialized.
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
 * Set to true after {@link initSentryIfEnabled} has actually run `Sentry.init`.
 * Read by {@link reportProviderError} so the call site can be invoked
 * unconditionally without knowing whether the SDK is loaded.
 */
let sentryInitialized = false;

/** True iff {@link initSentryIfEnabled} has been called and Sentry was initialized. */
export function isSentryInitialized(): boolean {
	return sentryInitialized;
}

/** Reset the initialization flag. Test-only. */
export function _resetSentryInitializedForTests(): void {
	sentryInitialized = false;
}

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
	sentryInitialized = true;

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

/**
 * Public surface for application code to report a non-fatal error that the
 * agent caught and re-encoded as a normal stream/UI event. The agent's LLM
 * adapters are contractually required to never throw (see
 * `packages/agent/src/types.ts`), so HTTP 400s, network failures, and other
 * provider errors land in an `AssistantMessage` with
 * `stopReason: "error"` and never reach the `uncaughtException` listener.
 *
 * This function is a no-op unless the user opted in via
 * `PI_AI_DEBUG=1` AND `SENTRY_DSN`, in which case it ships a Sentry event
 * tagged with `source: "provider_error"`, `stop_reason`, and (if parseable
 * from the error message) `request_id`. `provider` and `model` are attached
 * as scope extras so the Sentry UI can filter by them.
 *
 * The `message` should be the same string the agent already shows in the
 * TUI (e.g. `assistantMsg.errorMessage`); we wrap it in a synthetic `Error`
 * so the SDK can format it as a real exception with a stack.
 */
export interface ProviderErrorReport {
	/** Error message as surfaced to the user (e.g. assistantMsg.errorMessage). */
	message: string;
	/** The stream-protocol stop reason. `error` or `aborted` are the common cases. */
	stopReason: string;
	/** Optional provider id (e.g. "anthropic", "openai"). Attached as scope extra. */
	provider?: string;
	/** Optional model id (e.g. "claude-opus-4-1"). Attached as scope extra. */
	model?: string;
	/** Optional pre-extracted request id. If omitted we try to parse it from `message`. */
	requestId?: string;
}

const REQUEST_ID_RE = /"request[__-]?id"\s*:\s*"([A-Za-z0-9_-]+)"/;

function extractRequestId(message: string): string | undefined {
	const match = REQUEST_ID_RE.exec(message);
	return match?.[1];
}

export function reportProviderError(report: ProviderErrorReport): void {
	if (!sentryInitialized) return;
	const { message, stopReason, provider, model, requestId } = report;
	const finalRequestId = requestId ?? extractRequestId(message);
	const tags: Record<string, string> = {
		source: "provider_error",
		stop_reason: stopReason,
	};
	if (finalRequestId) tags.request_id = finalRequestId;
	try {
		Sentry.withScope((scope) => {
			if (provider) scope.setExtra("provider", provider);
			if (model) scope.setExtra("model", model);
			if (finalRequestId) scope.setExtra("request_id", finalRequestId);
			const error = new Error(message);
			error.name = `ProviderError[${stopReason}]`;
			Sentry.captureException(error, { tags });
		});
	} catch {
		// Never throw from a telemetry call.
	}
}

/**
 * Captures an uncaught exception as a Sentry event. Intended for use in a
 * `process.on("uncaughtException", ...)` handler that then needs to flush
 * the queue before the process exits. Pairs with {@link flushSentry}.
 *
 * No-op when Sentry is not initialized.
 */
export function captureUncaughtException(error: Error, extraTags?: Record<string, string>): void {
	if (!sentryInitialized) return;
	try {
		Sentry.captureException(error, { tags: { source: "uncaughtException", ...extraTags } });
	} catch {
		// Never throw from a telemetry call.
	}
}

/**
 * Flushes the Sentry queue. Resolves after the transport has sent pending
 * events or after `timeoutMs` (whichever comes first). No-op when Sentry is
 * not initialized.
 */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
	if (!sentryInitialized) return;
	try {
		await Sentry.close(timeoutMs);
	} catch {
		// Best-effort flush; never throw.
	}
}
