/**
 * Sentry-backed telemetry adapter.
 *
 * Implements the {@link TelemetryContext} contract while also queueing spans
 * and captured errors as Sentry envelopes. Envelopes are dispatched through a
 * caller-supplied {@link SentryTransport} so the `telemetry` package keeps its
 * zero-runtime-dependency invariant; the coding-agent supplies an undici-
 * based transport at startup.
 *
 * Reference: https://develop.sentry.dev/sdk/envelopes/
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
	AttributeValue,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "./index.ts";
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

/* ────────────────────────────────────────────────────────────────────────── */
/* DSN parsing                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SentryDsn {
	readonly protocol: "http" | "https";
	readonly publicKey: string;
	readonly host: string;
	readonly port?: number;
	readonly path: string;
	readonly projectId: string;
	readonly envelopeEndpoint: string;
}

const DSN_PATTERN = /^(https?):\/\/([a-zA-Z0-9_-]+)@([a-zA-Z0-9.-]+(?::\d+)?)(.+)$/;

export function parseSentryDsn(input: string): SentryDsn {
	const hashIndex = input.indexOf("#");
	const queryIndex = input.indexOf("?");
	const lastDisallowed = Math.max(hashIndex, queryIndex);
	const cleanInput = lastDisallowed >= 0 ? input.slice(0, lastDisallowed) : input;
	const match = DSN_PATTERN.exec(cleanInput);
	if (!match) throw new Error(`Invalid Sentry DSN: ${input}`);
	const protocol = match[1] as "http" | "https";
	const publicKey = match[2];
	const hostAndPort = match[3];
	const tail = match[4];
	if (!hostAndPort) throw new Error(`Invalid Sentry DSN: missing host in ${input}`);
	const [host, portRaw] = hostAndPort.split(":");
	if (!host) throw new Error(`Invalid Sentry DSN: missing host in ${input}`);
	const port = portRaw === undefined ? undefined : Number.parseInt(portRaw, 10);
	if (port !== undefined && (Number.isNaN(port) || port <= 0 || port > 65535)) {
		throw new Error(`Invalid Sentry DSN: invalid port ${portRaw}`);
	}
	if (!tail.startsWith("/")) {
		throw new Error(`Invalid Sentry DSN: expected "/" before project id in ${input}`);
	}
	const trimmedTail = tail.replace(/\/+$/, "") || "/";
	const lastSlash = trimmedTail.lastIndexOf("/");
	if (lastSlash < 0) {
		throw new Error(`Invalid Sentry DSN: missing project id in ${input}`);
	}
	const projectId = trimmedTail.slice(lastSlash + 1);
	if (!/^\d+$/.test(projectId)) {
		throw new Error(`Invalid Sentry DSN: project id must be numeric in ${input}`);
	}
	const pathSegment = trimmedTail.slice(0, lastSlash);
	const path = pathSegment === "" ? "" : `${pathSegment}/`;
	const base = `${protocol}://${hostAndPort}${path === "" ? "/" : path}`;
	return {
		protocol,
		publicKey,
		host,
		...(port === undefined ? {} : { port }),
		path,
		projectId,
		envelopeEndpoint: `${base}api/${projectId}/envelope/`,
	};
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Sentry envelope and event shapes                                           */
/* ────────────────────────────────────────────────────────────────────────── */

export type SentryLogLevel = "fatal" | "error" | "warning" | "info" | "debug";
export type SentrySpanStatus = "ok" | "error" | "cancelled" | "internal_error" | "unknown" | "aborted";

export interface SentryEnvelopeTrace {
	readonly trace_id: string;
	public_key: string;
	readonly sample_rate: number;
	readonly sampled: boolean;
}

export interface SentryEnvelopeHeader {
	readonly event_id: string;
	readonly sent_at: string;
	readonly sdk: { readonly name: string; readonly version: string };
	readonly trace?: SentryEnvelopeTrace;
}

export interface SentryEnvelopeItem<T = unknown> {
	readonly type: string;
	readonly body: T;
}

export interface SentryEnvelope {
	readonly headers: SentryEnvelopeHeader;
	readonly items: readonly SentryEnvelopeItem[];
}

export interface SentryExceptionValue {
	readonly type: string;
	readonly value: string;
	readonly stacktrace?: { readonly frames: readonly SentryStackFrame[] };
}

export interface SentryStackFrame {
	readonly filename?: string;
	readonly function?: string;
	readonly lineno?: number;
	readonly colno?: number;
	readonly abs_path?: string;
	readonly in_app?: boolean;
}

export interface SentryBreadcrumb {
	readonly timestamp: number;
	readonly message: string;
	readonly category?: string;
	readonly level?: SentryLogLevel;
	readonly data?: Record<string, unknown>;
}

export interface SentryEvent {
	readonly event_id?: string;
	readonly timestamp?: number;
	readonly platform?: string;
	readonly level?: SentryLogLevel;
	readonly logger?: string;
	readonly transaction?: string;
	readonly server_name?: string;
	readonly release?: string;
	readonly environment?: string;
	readonly tags?: Readonly<Record<string, string>>;
	readonly extra?: Readonly<Record<string, unknown>>;
	readonly user?: { id?: string; email?: string; username?: string; ip_address?: string };
	readonly message?: string | { readonly formatted: string };
	readonly exception?: { readonly values: readonly SentryExceptionValue[] };
	readonly breadcrumbs?: readonly SentryBreadcrumb[];
}

export interface SentryTransaction {
	readonly type: "transaction";
	readonly event_id: string;
	readonly timestamp: number;
	readonly start_timestamp: number;
	readonly platform: "node";
	readonly transaction: string;
	readonly contexts: { readonly trace: SentryTransactionContext };
	readonly tags?: Readonly<Record<string, string>>;
	readonly extra?: Readonly<Record<string, unknown>>;
	readonly spans: readonly SentryTransactionSpan[];
}

export interface SentryTransactionContext {
	readonly trace_id: string;
	readonly span_id: string;
	readonly op?: string;
	readonly description?: string;
	readonly status?: SentrySpanStatus;
}

export interface SentryTransactionSpan {
	readonly span_id: string;
	readonly parent_span_id?: string;
	readonly trace_id: string;
	readonly description: string;
	readonly start_timestamp: number;
	readonly timestamp: number;
	readonly status?: SentrySpanStatus;
	readonly tags?: Readonly<Record<string, string>>;
	readonly data?: Readonly<Record<string, AttributeValue | undefined>>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Transport                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** Sends a single Sentry envelope. The transport owns serialization. */
export interface SentryTransport {
	send(envelope: SentryEnvelope): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Span / exception helpers                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function mapSpanStatus(status: SpanStatus): SentrySpanStatus {
	return status.status === "ok" ? "ok" : "error";
}

function describeError(error: unknown): string {
	if (error === undefined) return "undefined";
	if (error === null) return "null";
	try {
		const stringified = JSON.stringify(error);
		if (stringified !== undefined) return stringified;
	} catch {
		// Fall through to String().
	}
	try {
		return String(error);
	} catch {
		return "Unserializable error value";
	}
}

function errorToExceptionValue(error: unknown): SentryExceptionValue {
	if (error instanceof Error) {
		const value: SentryExceptionValue = {
			type: error.name || "Error",
			value: error.message || error.name || "Error",
		};
		const frames = parseStackTrace(error.stack);
		if (frames && frames.length > 0) {
			return { ...value, stacktrace: { frames } };
		}
		return value;
	}
	return { type: "UnknownError", value: describeError(error) };
}

const STACK_LINE_PATTERN = /\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/;

function parseStackTrace(stack: string | undefined): SentryStackFrame[] | undefined {
	if (!stack) return undefined;
	const frames: SentryStackFrame[] = [];
	for (const line of stack.split("\n")) {
		const match = STACK_LINE_PATTERN.exec(line);
		if (!match) continue;
		const functionName = match[1]?.trim();
		const filename = match[2];
		const linenoRaw = match[3];
		const colnoRaw = match[4];
		const lineno = linenoRaw ? Number.parseInt(linenoRaw, 10) : undefined;
		const colno = colnoRaw ? Number.parseInt(colnoRaw, 10) : undefined;
		const inApp = isInAppFrame(filename);
		const frame: SentryStackFrame = {
			...(filename ? { filename } : {}),
			...(functionName ? { function: functionName } : {}),
			...(lineno !== undefined && !Number.isNaN(lineno) ? { lineno } : {}),
			...(colno !== undefined && !Number.isNaN(colno) ? { colno } : {}),
			in_app: inApp,
		};
		frames.push(frame);
	}
	return frames.length === 0 ? undefined : frames;
}

function isInAppFrame(filename: string | undefined): boolean {
	if (!filename) return false;
	if (filename.includes("node_modules/")) return false;
	if (filename.startsWith("node:")) return false;
	if (filename.startsWith("internal/")) return false;
	return true;
}

function copyAttributeValue(value: AttributeValue): AttributeValue {
	return Array.isArray(value) ? ([...value] as AttributeValue) : value;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	const copy: SpanAttributes = {};
	if (!attributes) return copy;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) copy[name] = copyAttributeValue(value);
	}
	return copy;
}

function mergeAttributes(current: SpanAttributes, attributes: SpanAttributes): SpanAttributes {
	const merged = copyAttributes(current);
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) merged[name] = copyAttributeValue(value);
	}
	return merged;
}

function copyStatus(status: SpanStatus): SpanStatus {
	if (status.status === "ok") return { status: "ok" };
	return status.error
		? { status: "error", error: { name: status.error.name, message: status.error.message } }
		: { status: "error" };
}

function automaticErrorStatus(error: unknown): SpanStatus {
	try {
		if (error instanceof Error) {
			return { status: "error", error: { name: error.name, message: error.message } };
		}
	} catch {
		// Passive: drop error details on inspection failure.
	}
	return { status: "error" };
}

function attributesToTags(attributes: SpanAttributes): Record<string, string> {
	const tags: Record<string, string> = {};
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		if (typeof value === "string") tags[name] = value;
		else if (typeof value === "number" || typeof value === "boolean") tags[name] = String(value);
	}
	return tags;
}

function attributesToData(attributes: SpanAttributes): Record<string, AttributeValue | undefined> {
	const data: Record<string, AttributeValue | undefined> = {};
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		data[name] = value;
	}
	return data;
}

function isSampled(rate: number): boolean {
	if (rate <= 0) return false;
	if (rate >= 1) return true;
	return Math.random() < rate;
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Span tree                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

interface MutableSpanEvent {
	name: string;
	timestamp: number;
	attributes: SpanAttributes;
}

interface MutableSpan {
	id: string;
	traceId: string;
	parent: MutableSpan | undefined;
	name: string;
	startTime: number;
	endTime: number;
	attributes: SpanAttributes;
	events: MutableSpanEvent[];
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
	children: MutableSpan[];
}

interface SentryTelemetryState {
	readonly dsn: SentryDsn;
	readonly now: () => number;
	rootSpans: MutableSpan[];
	pendingEvents: SentryEvent[];
	nextSpanId: number;
}

function generateSpanId(n: number): string {
	return n.toString(16).padStart(16, "0");
}

function generateTraceId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 32);
}

function generateEventId(): string {
	return randomUUID().replace(/-/g, "");
}

function createRootSpan(state: SentryTelemetryState, options: SpanOptions): MutableSpan {
	const id = generateSpanId(state.nextSpanId);
	state.nextSpanId++;
	return {
		id,
		traceId: generateTraceId(),
		parent: undefined,
		name: options.name,
		startTime: state.now(),
		endTime: 0,
		attributes: copyAttributes(options.attributes),
		events: [],
		status: { status: "ok" },
		explicitStatus: false,
		settled: false,
		children: [],
	};
}

function createChildSpan(state: SentryTelemetryState, parent: MutableSpan, options: SpanOptions): MutableSpan {
	const id = generateSpanId(state.nextSpanId);
	state.nextSpanId++;
	const child: MutableSpan = {
		id,
		traceId: parent.traceId,
		parent,
		name: options.name,
		startTime: state.now(),
		endTime: 0,
		attributes: copyAttributes(options.attributes),
		events: [],
		status: { status: "ok" },
		explicitStatus: false,
		settled: false,
		children: [],
	};
	parent.children.push(child);
	return child;
}

function settleSpan(span: MutableSpan, now: number, failed: boolean, error?: unknown): void {
	if (span.settled) return;
	if (failed && !span.explicitStatus) span.status = automaticErrorStatus(error);
	span.endTime = now;
	span.settled = true;
}

function startSentrySpan<T>(
	state: SentryTelemetryState,
	parent: MutableSpan | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.settled) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);

	const span: MutableSpan = parent ? createChildSpan(state, parent, options) : createRootSpan(state, options);
	if (!parent) state.rootSpans.push(span);

	const telemetrySpan: TelemetrySpan = {
		startSpan: <Result>(
			childOptions: SpanOptions,
			childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
		) => startSentrySpan(state, span, childOptions, childCallback),
		addEvent(name, attributes) {
			if (span.settled) return;
			try {
				span.events.push({
					name,
					timestamp: state.now(),
					attributes: copyAttributes(attributes),
				});
			} catch {
				// Passive: ignore malformed payloads.
			}
		},
		setAttributes(attributes) {
			if (span.settled) return;
			try {
				span.attributes = mergeAttributes(span.attributes, attributes);
			} catch {
				// Passive.
			}
		},
		setStatus(status) {
			if (span.settled) return;
			try {
				span.status = copyStatus(status);
				span.explicitStatus = true;
			} catch {
				// Passive.
			}
		},
	};

	let result: T | Promise<T>;
	try {
		result = callback(telemetrySpan);
	} catch (error) {
		settleSpan(span, state.now(), true, error);
		return Promise.reject(error);
	}

	return Promise.resolve(result).then(
		(value) => {
			settleSpan(span, state.now(), false);
			return value;
		},
		(error: unknown) => {
			settleSpan(span, state.now(), true, error);
			throw error;
		},
	);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Envelope construction                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function buildTransactionSpan(span: MutableSpan): SentryTransactionSpan {
	const tags = attributesToTags(span.attributes);
	const data = attributesToData(span.attributes);
	const txSpan: {
		span_id: string;
		parent_span_id?: string;
		trace_id: string;
		description: string;
		start_timestamp: number;
		timestamp: number;
		status?: SentrySpanStatus;
		tags?: Record<string, string>;
		data?: Record<string, AttributeValue | undefined>;
	} = {
		span_id: span.id,
		trace_id: span.traceId,
		description: span.name,
		start_timestamp: span.startTime,
		timestamp: span.endTime,
	};
	if (span.parent) txSpan.parent_span_id = span.parent.id;
	const status = mapSpanStatus(span.status);
	if (status) txSpan.status = status;
	if (Object.keys(tags).length > 0) txSpan.tags = tags;
	if (Object.keys(data).length > 0) txSpan.data = data;
	return txSpan as SentryTransactionSpan;
}

function buildTransaction(
	span: MutableSpan,
	release: string | undefined,
	environment: string | undefined,
): SentryTransaction {
	const tags = attributesToTags(span.attributes);
	const data = attributesToData(span.attributes);
	const traceContext: {
		trace_id: string;
		span_id: string;
		description?: string;
		status?: SentrySpanStatus;
	} = {
		trace_id: span.traceId,
		span_id: span.id,
		description: span.name,
	};
	const status = mapSpanStatus(span.status);
	if (status) traceContext.status = status;
	const tx: {
		type: "transaction";
		event_id: string;
		timestamp: number;
		start_timestamp: number;
		platform: "node";
		transaction: string;
		contexts: { trace: SentryTransactionContext };
		release?: string;
		environment?: string;
		tags?: Record<string, string>;
		extra?: Record<string, unknown>;
		spans: SentryTransactionSpan[];
	} = {
		type: "transaction",
		event_id: generateEventId(),
		timestamp: span.endTime,
		start_timestamp: span.startTime,
		platform: "node",
		transaction: span.name,
		contexts: { trace: traceContext as SentryTransactionContext },
		spans: [],
	};
	if (release !== undefined) tx.release = release;
	if (environment !== undefined) tx.environment = environment;
	if (Object.keys(tags).length > 0) tx.tags = tags;
	if (Object.keys(data).length > 0) tx.extra = { ...data };
	const queue: MutableSpan[] = [...span.children];
	while (queue.length > 0) {
		const child = queue.shift();
		if (!child) break;
		tx.spans.push(buildTransactionSpan(child));
		queue.push(...child.children);
	}
	return tx as SentryTransaction;
}

function buildEnvelopeHeader(
	dsn: SentryDsn,
	sdk: { name: string; version: string },
	trace?: Omit<SentryEnvelopeTrace, "public_key">,
): SentryEnvelopeHeader {
	if (trace) {
		return {
			event_id: generateEventId(),
			sent_at: new Date().toISOString(),
			sdk,
			trace: { ...trace, public_key: dsn.publicKey },
		};
	}
	return {
		event_id: generateEventId(),
		sent_at: new Date().toISOString(),
		sdk,
	};
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Context options                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SentryTelemetryContextOptions {
	readonly dsn: SentryDsn | string;
	readonly release?: string;
	readonly environment?: string;
	readonly serverName?: string;
	readonly transport: SentryTransport;
	/** Fraction (0..1) of root spans emitted as Sentry transactions. Default 0. */
	readonly tracesSampleRate?: number;
	/** Fraction (0..1) of captured errors emitted as Sentry events. Default 1. */
	readonly sampleRate?: number;
	readonly debug?: boolean;
	readonly sdk?: { readonly name: string; readonly version: string };
	/** Time provider for tests; defaults to `performance.now()`. */
	readonly now?: () => number;
	/** Filter that may return a modified event or `null` to drop it. */
	readonly beforeSend?: (event: SentryEvent) => SentryEvent | null;
}

const DEFAULT_SDK = { name: "pi-telemetry", version: "0.0.0" };

/* ────────────────────────────────────────────────────────────────────────── */
/* Context                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Sentry-backed telemetry context.
 *
 * Spans are recorded in memory and, on {@link flush}, dispatched as Sentry
 * `transaction` envelopes. Errors captured through {@link captureException} or
 * {@link captureMessage} become Sentry `event` envelopes.
 */
export class SentryTelemetryContext implements TelemetryContext {
	private readonly state: SentryTelemetryState;
	private readonly release: string | undefined;
	private readonly environment: string | undefined;
	private readonly transport: SentryTransport;
	private readonly tracesSampleRate: number;
	private readonly errorSampleRate: number;
	private readonly debug: boolean;
	private readonly sdk: { name: string; version: string };
	private readonly beforeSend: ((event: SentryEvent) => SentryEvent | null) | undefined;
	private user: SentryEvent["user"] | undefined;
	private readonly breadcrumbs: SentryBreadcrumb[] = [];
	private disposed = false;

	constructor(options: SentryTelemetryContextOptions) {
		const dsn = typeof options.dsn === "string" ? parseSentryDsn(options.dsn) : options.dsn;
		this.state = {
			dsn,
			now: options.now ?? (() => performance.now()),
			rootSpans: [],
			pendingEvents: [],
			nextSpanId: 1,
		};
		this.release = options.release;
		this.environment = options.environment;
		this.transport = options.transport;
		this.tracesSampleRate = clamp01(options.tracesSampleRate ?? 0);
		this.errorSampleRate = clamp01(options.sampleRate ?? 1);
		this.debug = options.debug ?? false;
		this.sdk = options.sdk ?? DEFAULT_SDK;
		this.beforeSend = options.beforeSend;
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return startSentrySpan(this.state, undefined, options, callback);
	}

	/** Captures an exception as a Sentry event. Returns the event id. */
	captureException(error: unknown, hint?: { tags?: Record<string, string>; extra?: Record<string, unknown> }): string {
		const eventId = generateEventId();
		if (this.disposed) return eventId;
		if (!isSampled(this.errorSampleRate)) return eventId;
		const event: SentryEvent = {
			event_id: eventId,
			timestamp: Date.now() / 1000,
			platform: "node",
			level: "error",
			exception: { values: [errorToExceptionValue(error)] },
			...(this.release ? { release: this.release } : {}),
			...(this.environment ? { environment: this.environment } : {}),
			...(this.user ? { user: this.user } : {}),
			...(hint?.tags ? { tags: { ...hint.tags } } : {}),
			...(hint?.extra ? { extra: { ...hint.extra } } : {}),
			...(this.breadcrumbs.length > 0 ? { breadcrumbs: [...this.breadcrumbs] } : {}),
		};
		const finalEvent = this.applyBeforeSend(event);
		if (finalEvent) this.state.pendingEvents.push(finalEvent);
		return eventId;
	}

	/** Captures a message as a Sentry event. Returns the event id. */
	captureMessage(
		message: string,
		level: SentryLogLevel = "info",
		hint?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
	): string {
		const eventId = generateEventId();
		if (this.disposed) return eventId;
		if (!isSampled(this.errorSampleRate)) return eventId;
		const event: SentryEvent = {
			event_id: eventId,
			timestamp: Date.now() / 1000,
			platform: "node",
			level,
			message: { formatted: message },
			...(this.release ? { release: this.release } : {}),
			...(this.environment ? { environment: this.environment } : {}),
			...(this.user ? { user: this.user } : {}),
			...(hint?.tags ? { tags: { ...hint.tags } } : {}),
			...(hint?.extra ? { extra: { ...hint.extra } } : {}),
			...(this.breadcrumbs.length > 0 ? { breadcrumbs: [...this.breadcrumbs] } : {}),
		};
		const finalEvent = this.applyBeforeSend(event);
		if (finalEvent) this.state.pendingEvents.push(finalEvent);
		return eventId;
	}

	/** Sets the user context for subsequent events. */
	setUser(user: SentryEvent["user"]): void {
		this.user = user ? { ...user } : undefined;
	}

	/** Records a breadcrumb for subsequent error events. */
	addBreadcrumb(breadcrumb: SentryBreadcrumb): void {
		if (this.disposed) return;
		this.breadcrumbs.push({ ...breadcrumb });
	}

	/**
	 * Sends all pending envelopes through the transport and clears the queue.
	 *
	 * Safe to call multiple times. Returns the number of envelopes dispatched.
	 */
	async flush(): Promise<number> {
		if (this.disposed) return 0;
		const events = this.state.pendingEvents.splice(0);
		const settledRoots = this.state.rootSpans.filter((span) => span.settled && isSampled(this.tracesSampleRate));
		this.state.rootSpans = this.state.rootSpans.filter((span) => !span.settled);

		const envelopes: SentryEnvelope[] = [];
		for (const span of settledRoots) {
			envelopes.push({
				headers: buildEnvelopeHeader(this.state.dsn, this.sdk, {
					trace_id: span.traceId,
					sample_rate: this.tracesSampleRate,
					sampled: true,
				}),
				items: [{ type: "transaction", body: buildTransaction(span, this.release, this.environment) }],
			});
		}
		for (const event of events) {
			envelopes.push({
				headers: buildEnvelopeHeader(this.state.dsn, this.sdk),
				items: [{ type: "event", body: event }],
			});
		}

		let sent = 0;
		for (const envelope of envelopes) {
			try {
				await this.transport.send(envelope);
				sent++;
			} catch (error) {
				if (this.debug) {
					process.stderr.write(`[sentry] transport.send failed: ${describeError(error)}\n`);
				}
			}
		}
		return sent;
	}

	/** Flushes pending envelopes and prevents further captures. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.flush();
	}

	/** Returns the parsed DSN. */
	getDsn(): SentryDsn {
		return this.state.dsn;
	}

	/** Returns the Sentry envelope endpoint URL. */
	getEnvelopeEndpoint(): string {
		return this.state.dsn.envelopeEndpoint;
	}

	private applyBeforeSend(event: SentryEvent): SentryEvent | null {
		if (!this.beforeSend) return event;
		try {
			return this.beforeSend(event);
		} catch (error) {
			if (this.debug) {
				process.stderr.write(`[sentry] beforeSend threw: ${describeError(error)}\n`);
			}
			return null;
		}
	}
}
