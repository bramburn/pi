// Unit tests for the shared provider error-body normalizer.
//
// See issues/provider-error-body-passthrough. These cover one synthesized error
// object per SDK shape (Mistral, openai APIError, @google/genai ApiError, AWS
// Bedrock ServiceException), plus the non-Error fallback, truncation, the empty
// parsed-body edge case, and the formatProviderError compose helper.

import { describe, expect, it } from "vitest";
import {
	classifyErrorBody,
	extractCloudflareRequestId,
	formatProviderError,
	MAX_PROVIDER_ERROR_BODY_CHARS,
	normalizeProviderError,
} from "../src/utils/error-body.ts";

describe("normalizeProviderError", () => {
	it("extracts status and body from a Mistral-shaped error", () => {
		const error = Object.assign(new Error("Mistral request failed"), {
			statusCode: 403,
			body: '{"error":"blocked by gateway WAF"}',
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"error":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("reads the parsed body off an openai APIError when the message is opaque", () => {
		// makeMessage(status, error, message) yields "<status> status code (no body)"
		// when the parsed body is unparsed, while the body stays on error.error.
		const error = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: { error: "blocked by gateway WAF" },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"error":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("preserves the message when @google/genai already folds the body into it", () => {
		const body = { error: { code: 403, message: "Permission denied" } };
		const error = Object.assign(new Error(JSON.stringify(body)), {
			status: 403,
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.messageCarriesBody).toBe(true);
		expect(norm.message).toBe(JSON.stringify(body));
	});

	it("extracts status and body from a Bedrock-shaped ServiceException", () => {
		const error = Object.assign(new Error("UnknownError"), {
			name: "UnknownError",
			$metadata: { httpStatusCode: 403 },
			$response: { statusCode: 403, body: '{"message":"blocked by gateway WAF"}' },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"message":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("ignores a Bedrock response stream instead of serializing its internals", () => {
		const error = Object.assign(
			new Error("Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported."),
			{
				name: "ValidationException",
				$metadata: { httpStatusCode: 400 },
				$response: {
					statusCode: 400,
					body: { pipe: () => undefined, _events: { close: [null, null] } },
				},
			},
		);

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(400);
		expect(norm.body).toBeUndefined();
		expect(norm.message).toContain("on-demand throughput isn't supported");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("ignores a class-instance response body without a pipe method instead of serializing it", () => {
		// Not every SDK response wrapper is a node stream: web ReadableStreams
		// and SDK-specific wrapper classes have no `pipe`, but serializing them
		// still yields internals-noise that would replace the real message.
		class SdkHttpResponseBody {
			locked = false;
			state = { storedError: undefined };
		}
		const error = Object.assign(new Error("Input is too long for requested model."), {
			name: "ValidationException",
			$metadata: { httpStatusCode: 400 },
			$response: { statusCode: 400, body: new SdkHttpResponseBody() },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(400);
		expect(norm.body).toBeUndefined();
		expect(norm.message).toContain("Input is too long");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("ignores a class-instance `error` field instead of serializing it", () => {
		class SdkInnerError {
			code = "EPROTO";
			internalState = {};
		}
		const error = Object.assign(new Error("TLS handshake failed"), {
			status: 502,
			error: new SdkInnerError(),
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBeUndefined();
		expect(norm.message).toBe("TLS handshake failed");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("still surfaces a plain parsed JSON body object", () => {
		const error = Object.assign(new Error("400 status code (no body)"), {
			status: 400,
			error: { message: "schema validation failed", field: "tools[0]" },
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBe('{"message":"schema validation failed","field":"tools[0]"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("JSON-stringifies a non-Error thrown value", () => {
		const norm = normalizeProviderError({ reason: "boom" });

		expect(norm.status).toBeUndefined();
		expect(norm.body).toBeUndefined();
		expect(norm.message).toBe('{"reason":"boom"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("treats an empty parsed body object as no body", () => {
		const error = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: {},
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBeUndefined();
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("truncates the body at the cap", () => {
		const longBody = "x".repeat(MAX_PROVIDER_ERROR_BODY_CHARS + 50);
		const error = Object.assign(new Error("failed"), {
			statusCode: 500,
			body: longBody,
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toContain("... [truncated 50 chars]");
		expect(norm.body?.length).toBeLessThan(longBody.length);
	});

	it("sets messageCarriesBody when the message already contains the extracted body", () => {
		const error = Object.assign(new Error("500: upstream exploded"), {
			statusCode: 500,
			body: "upstream exploded",
		});

		const norm = normalizeProviderError(error);

		expect(norm.messageCarriesBody).toBe(true);
	});
});

describe("formatProviderError", () => {
	it("surfaces status and body without a prefix", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("403 status code (no body)"), {
				status: 403,
				error: { error: "blocked by gateway WAF" },
			}),
		);

		const formatted = formatProviderError(norm);

		expect(formatted).toContain("403");
		expect(formatted).toContain("blocked by gateway WAF");
		expect(formatted).not.toBe("403 status code (no body)");
	});

	it("applies a provider prefix with status and body", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("403 status code (no body)"), {
				status: 403,
				error: { error: "blocked by gateway WAF" },
			}),
		);

		expect(formatProviderError(norm, "OpenAI API error")).toBe(
			'OpenAI API error (403): {"error":"blocked by gateway WAF"}',
		);
	});

	it("preserves the message (with prefix + status) when it already carries the body", () => {
		const body = JSON.stringify({ error: { message: "Permission denied" } });
		const norm = normalizeProviderError(Object.assign(new Error(body), { status: 403 }));

		expect(formatProviderError(norm, "OpenAI API error")).toBe(`OpenAI API error (403): ${body}`);
	});

	it("returns the bare message for a non-Error value", () => {
		const norm = normalizeProviderError({ reason: "boom" });

		expect(formatProviderError(norm)).toBe('{"reason":"boom"}');
	});
});

describe("classifyErrorBody", () => {
	it("classifies a Cloudflare challenge body", () => {
		const body =
			"<!DOCTYPE html><html><body>404: Not Found<script>__CF$cv$params={r:'a391f29a4ad3ed0c',t:'MTc4OTA4MDE2NQ=='}</script></body></html>";
		expect(classifyErrorBody(body)).toBe("cloudflare-challenge");
	});

	it("classifies a Next.js HTML 404 as html", () => {
		expect(classifyErrorBody("<!DOCTYPE html><html><body><h2>404: Not Found</h2></body></html>")).toBe("html");
	});

	it("classifies upper-case HTML and xml prolog as html", () => {
		expect(classifyErrorBody("<HTML><body></body></HTML>")).toBe("html");
		expect(classifyErrorBody('<?xml version="1.0" encoding="UTF-8"?><root/>')).toBe("html");
	});

	it("passes JSON through unchanged", () => {
		expect(classifyErrorBody('{"error":"blocked by gateway WAF"}')).toBe("json");
		expect(classifyErrorBody("[1, 2, 3]")).toBe("json");
	});

	it("falls back to text for plain strings", () => {
		expect(classifyErrorBody("upstream exploded")).toBe("text");
	});

	it("returns text for an empty or missing body", () => {
		expect(classifyErrorBody("")).toBe("text");
		expect(classifyErrorBody(undefined)).toBe("text");
	});
});

describe("extractCloudflareRequestId", () => {
	it("returns the r value from __CF$cv$params", () => {
		const body = "...<script>...window.__CF$cv$params={r:'a391f29a4ad3ed0c',t:'MTc4OTA4MDE2NQ=='};</script>";
		expect(extractCloudflareRequestId(body)).toBe("a391f29a4ad3ed0c");
	});

	it("works with double quotes around the r value", () => {
		const body = '__CF$cv$params={r:"deadbeef",t:"1"}';
		expect(extractCloudflareRequestId(body)).toBe("deadbeef");
	});

	it("returns undefined when the marker is missing", () => {
		expect(extractCloudflareRequestId("<html>not a challenge</html>")).toBeUndefined();
	});
});

describe("formatProviderError with HTML / Cloudflare-challenge bodies", () => {
	const htmlBody =
		"<!DOCTYPE html><html data-dpl-id=\"dpl_881zSnaBmgZRtstbA6dF8YS5Qui5\" id=\"__next_error__\"><head>...</head><body><h2>404: Not Found</h2><script>(function(){...window.__CF$cv$params={r:'a391f29a4ad3ed0c',t:'MTc4OTA4MDE2NQ=='};...</script></body></html>";

	it("replaces an HTML body with a short placeholder (no raw HTML in the output)", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("404 status code (no body)"), {
				status: 404,
				error: { error: { message: htmlBody } },
			}),
		);

		const formatted = formatProviderError(norm);

		expect(formatted).toContain("404");
		expect(formatted).not.toContain("<!DOCTYPE");
		expect(formatted).not.toContain("__next_error__");
		expect(formatted).not.toContain(htmlBody);
	});

	it("includes the Cloudflare request-id when the body is a CF challenge page", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("404 status code (no body)"), {
				status: 404,
				error: { error: { message: htmlBody } },
			}),
		);

		const formatted = formatProviderError(norm, "OpenRouter API error");

		expect(formatted).toBe(
			"OpenRouter API error (404): unexpected HTML response; the provider is behind Cloudflare and served a challenge page (cf-request-id: a391f29a4ad3ed0c)",
		);
	});

	it("falls back to a generic CF message when the request-id cannot be extracted", () => {
		const cfBody = "<!DOCTYPE html><html><body><script>__CF$cv$params={t:'MTc4OTA4MDE2NQ=='}</script></body></html>";
		const norm = normalizeProviderError(
			Object.assign(new Error("404 status code (no body)"), {
				status: 404,
				error: { error: { message: cfBody } },
			}),
		);

		const formatted = formatProviderError(norm, "OpenRouter");

		expect(formatted).toBe(
			"OpenRouter (404): unexpected HTML response; the provider is behind Cloudflare and served a challenge page",
		);
	});

	it("still surfaces a plain JSON body verbatim", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("400 status code (no body)"), {
				status: 400,
				error: { error: "blocked by gateway WAF" },
			}),
		);

		const formatted = formatProviderError(norm, "OpenAI API error");

		expect(formatted).toBe('OpenAI API error (400): {"error":"blocked by gateway WAF"}');
	});

	it("handles an HTML 5xx body via the placeholder", () => {
		const body = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
		const norm = normalizeProviderError(
			Object.assign(new Error("502 status code (no body)"), {
				status: 502,
				error: { error: { message: body } },
			}),
		);

		const formatted = formatProviderError(norm, "OpenRouter");

		expect(formatted).toBe(
			"OpenRouter (502): unexpected HTML response from the provider; the response body was hidden",
		);
	});

	it("returns the bare message when body is undefined", () => {
		const norm: { status?: number; body?: string; message: string; messageCarriesBody: boolean } = {
			status: undefined,
			body: undefined,
			message: "connection reset",
			messageCarriesBody: true,
		};

		expect(formatProviderError(norm)).toBe("connection reset");
		expect(formatProviderError(norm, "OpenRouter")).toBe("connection reset");
	});

	it("replaces the HTML markup when the openai SDK folded it into error.message (the realistic path)", () => {
		// openai SDK APIError: when the response body is not valid JSON (e.g. an
		// HTML 4xx page), the SDK leaves `error.error` undefined and puts the raw
		// body into `error.message` as "<status> <body>". `extractBody` returns
		// undefined in that shape, so `norm.messageCarriesBody` is true. The
		// placeholder path must still trigger off `norm.message`.
		const htmlBody =
			"<!DOCTYPE html><html id=\"__next_error__\"><body><h2>404: Not Found</h2><script>window.__CF$cv$params={r:'a391f29a4ad3ed0c',t:'MTc4OTA4MDE2NQ=='};</script></body></html>";
		const error = Object.assign(new Error(`404 ${htmlBody}`), { status: 404 });
		const norm = normalizeProviderError(error);

		const formatted = formatProviderError(norm, "OpenRouter API error");

		expect(formatted).toBe(
			"OpenRouter API error (404): unexpected HTML response; the provider is behind Cloudflare and served a challenge page (cf-request-id: a391f29a4ad3ed0c)",
		);
		// Raw markup must NOT leak through.
		expect(formatted).not.toContain("<!DOCTYPE");
		expect(formatted).not.toContain("<html");
		expect(formatted).not.toContain(htmlBody);
	});

	it("replaces plain HTML in error.message without a CF id", () => {
		const htmlBody = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
		const error = Object.assign(new Error(`502 ${htmlBody}`), { status: 502 });
		const norm = normalizeProviderError(error);

		const formatted = formatProviderError(norm, "OpenRouter");

		expect(formatted).toBe(
			"OpenRouter (502): unexpected HTML response from the provider; the response body was hidden",
		);
	});
});
