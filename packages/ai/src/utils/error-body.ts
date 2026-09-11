// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

/**
 * Coarse classification of an HTTP error body. Used to decide whether
 * `formatProviderError` should hide the body (HTML / Cloudflare challenge)
 * or surface it as-is (JSON / plain text).
 *
 * Exported for tests and for callers that want to inspect how the body was
 * classified (e.g. for logging).
 */
export type ErrorBodyKind = "json" | "html" | "cloudflare-challenge" | "text";

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	// The openai SDK folds non-JSON response bodies into `error.message`
	// itself (it only attaches the body as a parsed object on `error.error`
	// when the body parses as JSON). HTML responses therefore arrive with
	// `messageCarriesBody === true` and the raw markup sitting in
	// `norm.message` — classify `message` first so the placeholder path
	// catches the actual production code path.
	const messageAsPlaceholder = buildHtmlBodyPlaceholder(norm.status, norm.message, prefix, true);
	if (messageAsPlaceholder !== undefined) return messageAsPlaceholder;
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	const bodyAsPlaceholder = buildHtmlBodyPlaceholder(norm.status, norm.body, prefix, false);
	if (bodyAsPlaceholder !== undefined) return bodyAsPlaceholder;
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

/**
 * Strip the `<status> ` prefix that the openai SDK prepends to non-JSON
 * response bodies in `error.message` (built by `makeMessage(status, errJSON,
 * errMessage)`). Returns the rest of the message unchanged when no leading
 * numeric prefix is found.
 *
 * Exported for tests and for callers that want to look at the body that
 * the SDK actually received.
 */
export function stripSdkStatusPrefix(message: string): string {
	return message.replace(/^\d{3}\s*/, "");
}

/**
 * Coarse classification of an HTTP error body. Detection is by a small set
 * of markers, not full HTML parsing, so the catch path stays cheap.
 *
 * The body may have been re-stringified from a parsed JSON object (the openai
 * SDK keeps parsed error bodies on `error.error` and `extractBody` re-emits
 * them), so when the prefix is a JSON delimiter, we ALSO scan inside the
 * stringified values for HTML or Cloudflare markers — otherwise an HTML
 * payload wrapped as `{"error":{"message":"<!DOCTYPE ..."}}` would slip past.
 *
 * Pass `stripSdkPrefix: true` when classifying an openai SDK
 * `error.message` (which has a `<status> ` prefix); the helper strips it
 * before scanning.
 */
export function classifyErrorBody(body: string | undefined, stripSdkPrefix = false): ErrorBodyKind {
	if (body === undefined || body.length === 0) return "text";
	const target = stripSdkPrefix ? stripSdkStatusPrefix(body) : body;
	// Cloudflare challenge/turnstile pages embed `__CF$cv$params` (a JS
	// payload seen in the wild) or `cf-chl-bypass` markup. The relevant
	// script is near the end of the page, so scan the full body.
	if (/__CF\$cv\$params/.test(target) || /__CF\$cv\$invoke/.test(target) || /cf-chl-bypass/i.test(target)) {
		return "cloudflare-challenge";
	}
	const trimmedStart = target.trimStart();
	if (
		trimmedStart.startsWith("<!DOCTYPE") ||
		trimmedStart.startsWith("<!doctype") ||
		trimmedStart.startsWith("<HTML") ||
		trimmedStart.startsWith("<html") ||
		trimmedStart.startsWith("<?xml")
	) {
		return "html";
	}
	if (trimmedStart.startsWith("{") || trimmedStart.startsWith("[")) {
		// Inside a JSON document, an HTML payload typically appears as a
		// string value. Detect the open tag of an HTML payload.
		if (/<!DOCTYPE|<HTML|<html|<\?xml|<body/i.test(target)) return "html";
		return "json";
	}
	return "text";
}

/**
 * Extract the Cloudflare request id from a challenge page body. The marker
 * is `__CF$cv$params={r:'<hex>',t:'<digits>'}`. The regex stops at the first
 * hex-looking sequence so it works even when the page is truncated.
 *
 * Returns undefined when the body does not contain the marker.
 */
export function extractCloudflareRequestId(body: string): string | undefined {
	const match = body.match(/__CF\$cv\$params[^}]*?r:["']([0-9a-fA-F]+)["']/);
	return match?.[1];
}

/**
 * Build a one-line placeholder error for HTML / Cloudflare-challenge bodies.
 * Returns undefined when the body should pass through unchanged.
 *
 * The placeholder references the provider prefix (when supplied) plus the
 * HTTP status. For Cloudflare challenges, the CF request id is appended so
 * the user has a stable reference when contacting support.
 */
function buildHtmlBodyPlaceholder(
	status: number | undefined,
	body: string,
	prefix: string | undefined,
	stripSdkPrefix: boolean,
): string | undefined {
	const kind = classifyErrorBody(body, stripSdkPrefix);
	if (kind !== "html" && kind !== "cloudflare-challenge") return undefined;
	const headParts: string[] = [];
	if (prefix !== undefined) headParts.push(prefix);
	if (status !== undefined) headParts.push(`(${status})`);
	const head = headParts.length > 0 ? `${headParts.join(" ")}: ` : "";
	if (kind === "cloudflare-challenge") {
		const cfId = extractCloudflareRequestId(body);
		const suffix =
			cfId !== undefined
				? `; the provider is behind Cloudflare and served a challenge page (cf-request-id: ${cfId})`
				: "; the provider is behind Cloudflare and served a challenge page";
		return `${head}unexpected HTML response${suffix}`;
	}
	return `${head}unexpected HTML response from the provider; the response body was hidden`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
