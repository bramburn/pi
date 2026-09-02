import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSentryInitializedForTests, isSentryDebugEnabled, reportProviderError } from "../src/core/sentry.ts";

const DSN = "https://public@o123.ingest.sentry.io/4505252978903040";

interface CapturedRequest {
	method: string;
	url: string;
	headers: NodeJS.Dict<string | string[]>;
	body: string;
}

async function startSentryMockServer(
	handler: (req: IncomingMessage, res: ServerResponse, body: string) => { status: number },
): Promise<{
	server: Server;
	port: number;
	requests: CapturedRequest[];
	close: () => Promise<void>;
}> {
	const requests: CapturedRequest[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			const { status } = handler(req, res, body);
			res.statusCode = status;
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to start mock server");
	}
	return {
		server,
		port: address.port,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

describe("Sentry gate", () => {
	beforeEach(() => {
		delete process.env.PI_AI_DEBUG;
		delete process.env.SENTRY_DSN;
	});

	it("requires both PI_AI_DEBUG=1 and SENTRY_DSN", () => {
		expect(isSentryDebugEnabled()).toBe(false);
		process.env.PI_AI_DEBUG = "1";
		expect(isSentryDebugEnabled()).toBe(false);
		process.env.SENTRY_DSN = DSN;
		expect(isSentryDebugEnabled()).toBe(true);
		process.env.PI_AI_DEBUG = "0";
		expect(isSentryDebugEnabled()).toBe(false);
	});
});

describe("Sentry Node SDK wiring (end-to-end)", () => {
	let mock: Awaited<ReturnType<typeof startSentryMockServer>> | undefined;

	beforeEach(() => {
		delete process.env.PI_AI_DEBUG;
		delete process.env.SENTRY_DSN;
	});

	afterEach(async () => {
		await mock?.close();
		mock = undefined;
	});

	it("loads the @sentry/node SDK and ships an envelope when an uncaught error fires", async () => {
		mock = await startSentryMockServer((_req, res) => {
			res.setHeader("x-sentry-id", "abc123");
			return { status: 200 };
		});
		const dsn = `http://public@127.0.0.1:${mock.port}/${DSN.split("/").pop()}`;
		process.env.SENTRY_DSN = dsn;
		process.env.PI_AI_DEBUG = "1";
		process.env.SENTRY_TRACES_SAMPLE_RATE = "0";

		// Import the wiring AFTER env vars are set so Sentry.init picks them up.
		const { initSentryIfEnabled } = await import("../src/core/sentry.ts");
		const handle = initSentryIfEnabled();
		expect(handle).toBeDefined();

		// Drive Sentry by capturing an exception through the public API.
		const Sentry = await import("@sentry/node");
		Sentry.captureException(new Error("end-to-end test"));
		await handle?.dispose();

		expect(mock.requests.length).toBeGreaterThan(0);
		// @sentry/node v10 emits a session envelope ({"type":"session"}) on
		// init/close before the event envelope. Find the event envelope
		// rather than assuming the first request is the event.
		const eventReq = mock.requests.find((req) => req.body.includes('"type":"event"'));
		expect(eventReq).toBeDefined();
		expect(eventReq!.method).toBe("POST");
		// Sentry Node SDK uses Transfer-Encoding: chunked and does not always set
		// content-type; we only check the envelope shape.
		const lines = eventReq!.body.split("\n").filter((line) => line.length > 0);
		const header = JSON.parse(lines[0]!);
		expect(header.sdk.name).toBe("sentry.javascript.node");
		// @sentry/node v10 dropped the `trace.public_key` envelope header;
		// auth now lives in the envelope endpoint URL (the DSN) rather than
		// in the per-request header. Release is similarly carried by the
		// event item itself.
		const itemHeader = JSON.parse(lines[1]!);
		expect(itemHeader.type).toBe("event");
		const event = JSON.parse(lines[2]!);
		expect(event.exception?.values?.[0]?.value).toBe("end-to-end test");
		expect(event.release).toContain("pi-coding-agent@");
		expect(event.environment).toBe("test");
	});

	it("is a no-op when PI_AI_DEBUG is unset even if SENTRY_DSN is set", async () => {
		mock = await startSentryMockServer(() => ({ status: 200 }));
		process.env.SENTRY_DSN = `http://public@127.0.0.1:${mock.port}/${DSN.split("/").pop()}`;
		// PI_AI_DEBUG intentionally unset.
		const { initSentryIfEnabled } = await import("../src/core/sentry.ts");
		const handle = initSentryIfEnabled();
		expect(handle).toBeUndefined();
		expect(mock.requests.length).toBe(0);
	});
});

describe("reportProviderError (provider/stream error path)", () => {
	let mock: Awaited<ReturnType<typeof startSentryMockServer>> | undefined;

	beforeEach(() => {
		delete process.env.PI_AI_DEBUG;
		delete process.env.SENTRY_DSN;
		// Reset the module-level `sentryInitialized` flag from any prior test that
		// called initSentryIfEnabled. Without this, the "is a no-op" test would
		// observe a leaked `true` from the previous describe block.
		_resetSentryInitializedForTests();
	});

	afterEach(async () => {
		await mock?.close();
		mock = undefined;
	});

	it("is a no-op when Sentry is not initialized", () => {
		// Should not throw and should not try to send anything.
		expect(() =>
			reportProviderError({
				message:
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, 400 (2013)"},"request_id":"06e38aa94e9229002663399d42323bf3"}',
				stopReason: "error",
				provider: "anthropic",
				model: "claude-opus-4-1",
			}),
		).not.toThrow();
	});

	it("ships an envelope with provider_error tags and parses request_id from the message", async () => {
		mock = await startSentryMockServer((_req, res) => {
			res.setHeader("x-sentry-id", "abc123");
			return { status: 200 };
		});
		const dsn = `http://public@127.0.0.1:${mock.port}/${DSN.split("/").pop()}`;
		process.env.SENTRY_DSN = dsn;
		process.env.PI_AI_DEBUG = "1";
		process.env.SENTRY_TRACES_SAMPLE_RATE = "0";

		const { initSentryIfEnabled } = await import("../src/core/sentry.ts");
		const handle = initSentryIfEnabled();
		expect(handle).toBeDefined();

		const message =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, 400 (2013)"},"request_id":"06e38aa94e9229002663399d42323bf3"}';
		reportProviderError({
			message,
			stopReason: "error",
			provider: "anthropic",
			model: "claude-opus-4-1",
		});
		await handle?.dispose();

		expect(mock.requests.length).toBeGreaterThan(0);
		const envelopeReq = mock.requests[0]!;
		const lines = envelopeReq.body.split("\n").filter((line) => line.length > 0);
		const event = JSON.parse(lines[2]!);
		expect(event.exception?.values?.[0]?.value).toBe(message);
		expect(event.exception?.values?.[0]?.type).toBe("ProviderError[error]");
		expect(event.tags?.source).toBe("provider_error");
		expect(event.tags?.stop_reason).toBe("error");
		expect(event.tags?.request_id).toBe("06e38aa94e9229002663399d42323bf3");
		// provider/model are scope extras, surfaced on the event under `extra`.
		const extras = event.extra ?? {};
		expect(extras.provider).toBe("anthropic");
		expect(extras.model).toBe("claude-opus-4-1");
		expect(extras.request_id).toBe("06e38aa94e9229002663399d42323bf3");
	});

	it("uses the explicit requestId over the parsed one when both are present", async () => {
		mock = await startSentryMockServer(() => ({ status: 200 }));
		const dsn = `http://public@127.0.0.1:${mock.port}/${DSN.split("/").pop()}`;
		process.env.SENTRY_DSN = dsn;
		process.env.PI_AI_DEBUG = "1";
		process.env.SENTRY_TRACES_SAMPLE_RATE = "0";

		const { initSentryIfEnabled } = await import("../src/core/sentry.ts");
		const handle = initSentryIfEnabled();
		expect(handle).toBeDefined();

		reportProviderError({
			message: '400 {"request_id":"fromMessage"}',
			stopReason: "error",
			requestId: "fromArgument",
		});
		await handle?.dispose();

		const envelopeReq = mock.requests[0]!;
		const lines = envelopeReq.body.split("\n").filter((line) => line.length > 0);
		const event = JSON.parse(lines[2]!);
		expect(event.tags?.request_id).toBe("fromArgument");
	});

	it("omits the request_id tag when the message has no JSON-shaped request id", async () => {
		mock = await startSentryMockServer(() => ({ status: 200 }));
		const dsn = `http://public@127.0.0.1:${mock.port}/${DSN.split("/").pop()}`;
		process.env.SENTRY_DSN = dsn;
		process.env.PI_AI_DEBUG = "1";
		process.env.SENTRY_TRACES_SAMPLE_RATE = "0";

		const { initSentryIfEnabled } = await import("../src/core/sentry.ts");
		const handle = initSentryIfEnabled();
		expect(handle).toBeDefined();

		reportProviderError({ message: "Plain network error", stopReason: "error" });
		await handle?.dispose();

		const envelopeReq = mock.requests[0]!;
		const lines = envelopeReq.body.split("\n").filter((line) => line.length > 0);
		const event = JSON.parse(lines[2]!);
		expect(event.tags?.source).toBe("provider_error");
		expect(event.tags?.stop_reason).toBe("error");
		expect(event.tags?.request_id).toBeUndefined();
	});
});
