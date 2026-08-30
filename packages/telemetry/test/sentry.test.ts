import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	parseSentryDsn,
	type SentryEnvelope,
	type SentryEvent,
	type SentryTelemetryContext,
	SentryTelemetryContext as SentryTelemetryContextClass,
	type SentryTransaction,
	type SentryTransport,
} from "../src/index.ts";

const DSN = "https://public@o123.ingest.sentry.io/4505252978903040";

class RecordingTransport {
	readonly envelopes: SentryEnvelope[] = [];
	send: SentryTransport["send"];
	constructor(failCount = 0) {
		let calls = 0;
		this.send = async (envelope: SentryEnvelope) => {
			calls++;
			if (calls <= failCount) throw new Error(`transport failure ${calls}`);
			this.envelopes.push(envelope);
		};
	}
}

function makeContext(
	transport: SentryTransport,
	options: Partial<ConstructorParameters<typeof SentryTelemetryContextClass>[0]> = {},
): SentryTelemetryContext {
	return new SentryTelemetryContextClass({
		dsn: DSN,
		release: "pi@0.0.0",
		environment: "test",
		tracesSampleRate: 1,
		sampleRate: 1,
		now: () => 0,
		transport,
		...options,
	});
}

describe("parseSentryDsn", () => {
	it("extracts public key, host, port, path, and project id from a standard DSN", () => {
		const dsn = parseSentryDsn(DSN);
		strictEqual(dsn.protocol, "https");
		strictEqual(dsn.publicKey, "public");
		strictEqual(dsn.host, "o123.ingest.sentry.io");
		strictEqual(dsn.path, "");
		strictEqual(dsn.projectId, "4505252978903040");
		strictEqual(dsn.envelopeEndpoint, "https://o123.ingest.sentry.io/api/4505252978903040/envelope/");
	});

	it("accepts a trailing slash after the project id", () => {
		const dsn = parseSentryDsn(`${DSN}/`);
		strictEqual(dsn.projectId, "4505252978903040");
	});

	it("preserves an explicit port and path", () => {
		const dsn = parseSentryDsn("http://abc@self.host.example:9000/proxy/42/");
		strictEqual(dsn.protocol, "http");
		strictEqual(dsn.publicKey, "abc");
		strictEqual(dsn.host, "self.host.example");
		strictEqual(dsn.port, 9000);
		strictEqual(dsn.path, "/proxy/");
		strictEqual(dsn.projectId, "42");
		strictEqual(dsn.envelopeEndpoint, "http://self.host.example:9000/proxy/api/42/envelope/");
	});

	it("rejects malformed DSNs", () => {
		for (const bad of ["", "not a dsn", "https://example.com/1", "https://key@example.com/notanumber"]) {
			let threw = false;
			try {
				parseSentryDsn(bad);
			} catch {
				threw = true;
			}
			ok(threw, `expected ${JSON.stringify(bad)} to be rejected`);
		}
	});
});

describe("SentryTelemetryContext", () => {
	let transport: RecordingTransport;
	let context: SentryTelemetryContext;

	beforeEach(() => {
		transport = new RecordingTransport();
	});

	afterEach(async () => {
		if (context) await context.dispose();
	});

	it("implements TelemetryContext and admits spans synchronously and asynchronously", async () => {
		context = makeContext(transport);

		const result = await context.startSpan({ name: "outer" }, async (span) => {
			const innerResult = await span.startSpan({ name: "inner", attributes: { kind: "read" } }, (inner) => {
				inner.setStatus({ status: "ok" });
				inner.addEvent("step", { index: 1 });
				return 42;
			});
			strictEqual(innerResult, 42);
			return "done";
		});

		strictEqual(result, "done");
		const sent = await context.flush();
		strictEqual(sent, 1);
		strictEqual(transport.envelopes.length, 1);
		const envelope = transport.envelopes[0]!;
		strictEqual(envelope.items.length, 1);
		strictEqual(envelope.items[0]!.type, "transaction");
		const tx = envelope.items[0]!.body as SentryTransaction;
		strictEqual(tx.type, "transaction");
		strictEqual(tx.transaction, "outer");
		strictEqual(tx.platform, "node");
		strictEqual(tx.contexts.trace.trace_id.length, 32);
		strictEqual(tx.contexts.trace.span_id.length, 16);
		strictEqual(tx.contexts.trace.status, "ok");
		strictEqual(tx.spans.length, 1);
		strictEqual(tx.spans[0]!.description, "inner");
		strictEqual(tx.spans[0]!.trace_id, tx.contexts.trace.trace_id);
		ok(tx.spans[0]!.parent_span_id, "child span should have a parent");
		strictEqual(tx.spans[0]!.parent_span_id, tx.contexts.trace.span_id);
	});

	it("propagates callback rejection without dropping the rejected error", async () => {
		context = makeContext(transport);
		const thrown = new Error("boom");
		await context
			.startSpan({ name: "explode" }, () => {
				throw thrown;
			})
			.then(
				() => {
					throw new Error("expected rejection");
				},
				(error) => strictEqual(error, thrown),
			);

		await context.flush();
		const envelope = transport.envelopes[0]!;
		const tx = envelope.items[0]!.body as SentryTransaction;
		strictEqual(tx.contexts.trace.status, "error");
	});

	it("captures exceptions and emits event envelopes with stack frames", async () => {
		context = makeContext(transport);
		context.setUser({ id: "u1", username: "tester" });
		context.addBreadcrumb({ timestamp: 0, message: "previous step", category: "test" });
		const error = new Error("kaboom");
		const eventId = context.captureException(error, { tags: { feature: "x" } });
		ok(eventId.length > 0);

		const sent = await context.flush();
		strictEqual(sent, 1);
		const envelope = transport.envelopes[0]!;
		strictEqual(envelope.items[0]!.type, "event");
		const event = envelope.items[0]!.body as SentryEvent;
		strictEqual(event.level, "error");
		strictEqual(event.platform, "node");
		strictEqual(event.release, "pi@0.0.0");
		strictEqual(event.environment, "test");
		deepStrictEqual(event.user, { id: "u1", username: "tester" });
		deepStrictEqual(event.tags, { feature: "x" });
		ok(event.exception);
		strictEqual(event.exception!.values[0]!.type, "Error");
		strictEqual(event.exception!.values[0]!.value, "kaboom");
		ok(event.exception!.values[0]!.stacktrace, "stack frames should be parsed");
		const frames = event.exception!.values[0]!.stacktrace!.frames;
		ok(frames.length > 0);
		// Top frame should be the test's own file and marked in_app.
		ok(frames.some((frame) => frame.in_app));
	});

	it("captures messages with explicit level", async () => {
		context = makeContext(transport);
		context.captureMessage("hello world", "warning");
		await context.flush();
		const event = transport.envelopes[0]!.items[0]!.body as SentryEvent;
		strictEqual(event.level, "warning");
		const message = event.message;
		const messageText = typeof message === "string" ? message : message?.formatted;
		strictEqual(messageText, "hello world");
	});

	it("honors sampleRate=0 by dropping events but still admitting the callback", async () => {
		context = makeContext(transport, { sampleRate: 0 });
		await context.startSpan({ name: "ok" }, () => "ok");
		const id = context.captureException(new Error("dropped"));
		ok(id.length > 0);
		strictEqual(transport.envelopes.length, 0);
	});

	it("honors tracesSampleRate=0 by suppressing transactions while keeping errors", async () => {
		context = makeContext(transport, { tracesSampleRate: 0 });
		await context.startSpan({ name: "ok" }, () => "ok");
		context.captureException(new Error("kept"));
		const sent = await context.flush();
		strictEqual(sent, 1);
		strictEqual(transport.envelopes.length, 1);
		strictEqual(transport.envelopes[0]!.items[0]!.type, "event");
	});

	it("applies beforeSend to drop or mutate events", async () => {
		context = makeContext(transport, {
			beforeSend: (event) => {
				if (event.exception?.values[0]?.value === "scrub") return null;
				return { ...event, extra: { ...event.extra, scrubbed: true } };
			},
		});
		context.captureException(new Error("scrub"));
		context.captureException(new Error("keep"));
		const sent = await context.flush();
		strictEqual(sent, 1);
		const event = transport.envelopes[0]!.items[0]!.body as SentryEvent;
		strictEqual(event.exception?.values[0]?.value, "keep");
		strictEqual(event.extra?.scrubbed, true);
	});

	it("continues flushing when a transport call throws", async () => {
		const flaky = new RecordingTransport(1);
		context = makeContext(flaky);
		context.captureException(new Error("first"));
		context.captureException(new Error("second"));
		const sent = await context.flush();
		strictEqual(sent, 1);
		strictEqual(flaky.envelopes.length, 1);
	});

	it("sends nothing after dispose and re-flush is a no-op", async () => {
		context = makeContext(transport);
		context.captureException(new Error("before"));
		const before = await context.flush();
		strictEqual(before, 1);
		await context.dispose();
		context.captureException(new Error("after"));
		const after = await context.flush();
		strictEqual(after, 0);
	});

	it("encodes the public key in envelope header trace for transactions", async () => {
		context = makeContext(transport);
		await context.startSpan({ name: "tx" }, () => "ok");
		await context.flush();
		const envelope = transport.envelopes[0]!;
		ok(envelope.headers.trace, "transaction envelope should carry trace header");
		strictEqual(envelope.headers.trace!.public_key, "public");
		strictEqual(envelope.headers.trace!.sampled, true);
		strictEqual(envelope.headers.trace!.sample_rate, 1);
	});

	it("serializes the envelope header sent_at and sdk", async () => {
		context = makeContext(transport);
		await context.startSpan({ name: "tx" }, () => "ok");
		await context.flush();
		const envelope = transport.envelopes[0]!;
		strictEqual(envelope.headers.sdk.name, "pi-telemetry");
		ok(envelope.headers.sent_at, "sent_at should be set");
		ok(!Number.isNaN(Date.parse(envelope.headers.sent_at)), "sent_at should be ISO 8601");
		ok(envelope.headers.event_id.length >= 32, "event_id should be a 32-char hex string");
	});
});
