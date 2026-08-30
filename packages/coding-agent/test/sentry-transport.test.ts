import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSentryDebugEnabled } from "../src/core/sentry.ts";

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
		const envelopeReq = mock.requests[0]!;
		expect(envelopeReq.method).toBe("POST");
		// Sentry Node SDK uses Transfer-Encoding: chunked and does not always set
		// content-type; we only check the envelope shape.
		const lines = envelopeReq.body.split("\n").filter((line) => line.length > 0);
		const header = JSON.parse(lines[0]!);
		expect(header.sdk.name).toBe("sentry.javascript.node");
		expect(header.trace?.public_key).toBe("public");
		expect(header.trace?.release).toContain("pi-coding-agent@");
		// First item is an event; the SDK omits the per-item `length` field
		// because it streams the body via chunked transfer encoding.
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
