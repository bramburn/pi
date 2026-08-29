/**
 * Sentry telemetry wiring for the coding-agent CLI.
 *
 * The {@link createSentryTelemetry} helper builds a {@link SentryTelemetryContext}
 * that posts Sentry envelopes to the configured DSN using `undici`. The
 * caller is responsible for invoking {@link SentryTelemetryContext.dispose} on
 * process exit so pending transactions and captured errors are flushed.
 *
 * Enable by setting both `PI_AI_DEBUG=1` and `SENTRY_DSN=https://...@.../NN`.
 * `PI_AI_DEBUG` alone is treated as a no-op so dev/CI never silently phones
 * home without an explicit destination.
 */

import {
	parseSentryDsn,
	type SentryEnvelope,
	type SentryEvent,
	SentryTelemetryContext,
	type SentryTransport,
} from "@earendil-works/pi-telemetry";
import { request } from "undici";
import { APP_NAME, VERSION } from "../config.ts";

export interface CreateSentryTelemetryOptions {
	readonly dsn: string;
	readonly release?: string;
	readonly environment?: string;
	readonly tracesSampleRate?: number;
	readonly sampleRate?: number;
	readonly debug?: boolean;
	readonly beforeSend?: (event: SentryEvent) => SentryEvent | null;
}

const SENTRY_AUTH_SDK = `${APP_NAME}-coding-agent/${VERSION}`;

function buildSentryAuthHeader(publicKey: string): string {
	return `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=${SENTRY_AUTH_SDK}`;
}

function serializeEnvelope(envelope: SentryEnvelope): string {
	const parts: string[] = [JSON.stringify(envelope.headers)];
	for (const item of envelope.items) {
		const body = JSON.stringify(item.body);
		parts.push(JSON.stringify({ type: item.type, length: Buffer.byteLength(body, "utf8") }), body);
	}
	return parts.join("\n");
}

function createUndiciSentryTransport(endpoint: string, publicKey: string): SentryTransport {
	return {
		async send(envelope: SentryEnvelope): Promise<void> {
			const body = serializeEnvelope(envelope);
			const response = await request(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-sentry-envelope",
					"X-Sentry-Auth": buildSentryAuthHeader(publicKey),
					"User-Agent": `${APP_NAME}/${VERSION}`,
				},
				body,
				bodyTimeout: 10_000,
				headersTimeout: 10_000,
			});
			for await (const _chunk of response.body) {
				// Drain to release the socket.
			}
			if (response.statusCode >= 400) {
				throw new Error(`Sentry responded with HTTP ${response.statusCode}`);
			}
		},
	};
}

/** Returns a Sentry telemetry context for the configured DSN. */
export function createSentryTelemetry(options: CreateSentryTelemetryOptions): SentryTelemetryContext {
	const dsn = parseSentryDsn(options.dsn);
	const transport = createUndiciSentryTransport(dsn.envelopeEndpoint, dsn.publicKey);
	return new SentryTelemetryContext({
		dsn,
		transport,
		release: options.release ?? `${APP_NAME}-coding-agent@${VERSION}`,
		environment: options.environment ?? detectEnvironment(),
		tracesSampleRate: options.tracesSampleRate ?? 0,
		sampleRate: options.sampleRate ?? 1,
		debug: options.debug ?? false,
		...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
	});
}

/** Process-wide Sentry handle. Created by {@link initSentryIfEnabled} when both
 *  `PI_AI_DEBUG=1` and `SENTRY_DSN` are set. Disposed on process exit. */
export interface SentryContextHandle {
	readonly context: SentryTelemetryContext;
	dispose(): Promise<void>;
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
	const context = createSentryTelemetry({
		dsn,
		debug: isTruthyEnvFlag(process.env.PI_AI_DEBUG),
	});
	const handle: SentryContextHandle = {
		context,
		async dispose() {
			await context.dispose();
		},
	};

	const onUncaught = (error: unknown): void => {
		context.captureException(error, { tags: { source: "uncaughtException" } });
	};
	const onUnhandled = (reason: unknown): void => {
		context.captureException(reason, { tags: { source: "unhandledRejection" } });
	};
	const onWarning = (warning: Error): void => {
		context.captureException(warning, { tags: { source: "warning" } });
	};
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUnhandled);
	process.on("warning", onWarning);
	// Annotate the Sentry context for any subsequent errors with the running
	// CLI invocation so dashboards can group them by command + version.
	context.setUser({ username: `${APP_NAME}-cli@${VERSION}` });
	return handle;
}

/**
 * Returns true when the user has opted in to Sentry via `PI_AI_DEBUG` and
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
