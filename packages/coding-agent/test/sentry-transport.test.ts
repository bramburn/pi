import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSentryTelemetry, isSentryDebugEnabled } from "../src/core/sentry.ts";

const DSN = "https://public@o123.ingest.sentry.io/4505252978903040";

interface CapturedRequest {
	headers: NodeJS.Dict<string | string[]>;
	body: string;
}

async function startSentryMockServer(handler: (req: CapturedRequest) => { status: number }): Promise<{
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
			const captured: CapturedRequest = { headers: req.headers, body };
			requests.push(captured);
			const { status } = handler(captured);
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

describe("Sentry transport end-to-end", () => {
	let mock: Awaited<ReturnType<typeof startSentryMockServer>> | undefined;

	beforeEach(() => {
		delete process.env.PI_AI_DEBUG;
		delete process.env.SENTRY_DSN;
	});

	afterEach(async () => {
		await mock?.close();
		mock = undefined;
	});

	it("isSentryDebugEnabled requires both PI_AI_DEBUG=1 and SENTRY_DSN", () => {
		expect(isSentryDebugEnabled()).toBe(false);
		process.env.PI_AI_DEBUG = "1";
		expect(isSentryDebugEnabled()).toBe(false);
		process.env.SENTRY_DSN = DSN;
		expect(isSentryDebugEnabled()).toBe(true);
		process.env.PI_AI_DEBUG = "0";
		expect(isSentryDebugEnabled()).toBe(false);
	});

	it("posts a Sentry envelope to the configured DSN endpoint and serializes the wire format", async () => {
		process.env.PI_AI_DEBUG = "1";
		process.env.SENTRY_DSN = `http://public@127.0.0.1:${0}/${DSN.split("/").pop()}`;
		mock = await startSentryMockServer(() => ({ status: 200 }));
		process.env.SENTRY_DSN = `http://public@127.0.0.1:${mock.port}/${DSN.split("/").pop()}`;

		const ctx = createSentryTelemetry({ dsn: process.env.SENTRY_DSN });
		ctx.captureException(new Error("end-to-end test"));
		const sent = await ctx.flush();
		expect(sent).toBe(1);
		await ctx.dispose();

		expect(mock.requests.length).toBe(1);
		const request = mock.requests[0]!;
		expect(request.headers["content-type"]).toBe("application/x-sentry-envelope");
		const auth = request.headers["x-sentry-auth"];
		expect(Array.isArray(auth) ? auth[0] : auth).toMatch(/^Sentry sentry_version=7, sentry_key=public,/);
		const lines = request.body.split("\n");
		expect(lines.length).toBe(3);
		const header = JSON.parse(lines[0]!);
		expect(header.sdk.name).toBe("pi-telemetry");
		const itemHeader = JSON.parse(lines[1]!);
		expect(itemHeader.type).toBe("event");
		expect(itemHeader.length).toBe(Buffer.byteLength(lines[2]!, "utf8"));
		const event = JSON.parse(lines[2]!);
		expect(event.exception.values[0].value).toBe("end-to-end test");
	});

	it("treats non-2xx responses as transport failures and continues flushing", async () => {
		process.env.PI_AI_DEBUG = "1";
		mock = await startSentryMockServer(() => ({ status: 429 }));
		process.env.SENTRY_DSN = `http://public@127.0.0.1:${mock.port}/${DSN.split("/").pop()}`;

		const ctx = createSentryTelemetry({ dsn: process.env.SENTRY_DSN });
		ctx.captureException(new Error("first"));
		ctx.captureException(new Error("second"));
		const sent = await ctx.flush();
		// Both envelopes attempted; the 429 responses should not crash, but the
		// transport layer reports them as failures, so sent < 2.
		expect(sent).toBe(0);
		expect(mock.requests.length).toBe(2);
		await ctx.dispose();
	});
});
