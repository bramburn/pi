/**
 * Minimal JSON Schema validation for subagent structured output (issue #1045).
 *
 * The `subagent` tool lets the orchestrator attach an `outputSchema` to a spec.
 * The child's final output is then parsed as JSON and checked against that
 * schema by the **parent**, which is the only side that can turn a mismatch into
 * a failed subagent result. This module is that check.
 *
 * It is deliberately not a full JSON Schema implementation, and it adds no
 * dependency: it covers the subset a task author writes when they want machine
 * readable output back. Anything outside that subset is reported as an explicit
 * validation failure naming the unsupported construct rather than being
 * silently ignored — a silently ignored keyword would let a spec look enforced
 * while nothing enforced it.
 *
 * Supported: `type` (string/array), `properties`, `required`,
 * `additionalProperties: false`, `enum`, `items` (schema or tuple), `oneOf`,
 * `anyOf`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`.
 * `description` / `title` / `default` / `examples` / `$schema` / `$id` are
 * annotations and ignored.
 */

/** Maximum number of individual errors reported for one validation. */
const MAX_ERRORS = 20;

export interface SchemaValidationResult {
	ok: boolean;
	/** Human-readable, model-facing error strings. Empty when `ok`. */
	errors: string[];
}

const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples", "$schema", "$id"]);

const SUPPORTED_KEYWORDS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"enum",
	"items",
	"oneOf",
	"anyOf",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"pattern",
	...ANNOTATION_KEYWORDS,
]);

const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `$.user.name[0]` style paths, for error messages. */
function childPath(path: string, key: string | number, inArray = false): string {
	return inArray ? `${path}[${key}]` : path === "$" ? `$.${key}` : `${path}.${key}`;
}

class Sink {
	errors: string[] = [];
	fail(message: string): void {
		if (this.errors.length >= MAX_ERRORS) return;
		this.errors.push(message);
	}
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	if (typeof a === "object") {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const keys = Object.keys(ao);
		if (keys.length !== Object.keys(bo).length) return false;
		return keys.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Structural pass: reject schemas this validator cannot honor.
// ---------------------------------------------------------------------------

function checkSchema(schema: unknown, path: string, sink: Sink): void {
	if (!isPlainObject(schema)) {
		sink.fail(
			`Unsupported JSON Schema: ${path} must be an object schema, got ${schema === null ? "null" : describeValue(schema)}. Boolean and string schemas are not supported.`,
		);
		return;
	}

	for (const keyword of Object.keys(schema)) {
		if (!SUPPORTED_KEYWORDS.has(keyword)) {
			sink.fail(
				`Unsupported JSON Schema keyword "${keyword}" at ${path}. Remove it or express the constraint with the supported keywords (type, properties, required, items, additionalProperties, enum, oneOf, anyOf, minimum, maximum, minLength, maxLength, pattern).`,
			);
		}
	}

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		for (const t of types) {
			if (typeof t !== "string" || !JSON_TYPES.has(t)) {
				sink.fail(`Unsupported JSON Schema "type" value ${JSON.stringify(t)} at ${path}.`);
			}
		}
	}

	if (schema.properties !== undefined) {
		if (!isPlainObject(schema.properties)) {
			sink.fail(`Invalid JSON Schema: "properties" at ${path} must be an object.`);
		} else {
			for (const [key, sub] of Object.entries(schema.properties)) {
				checkSchema(sub, childPath(path, key), sink);
			}
		}
	}

	if (schema.required !== undefined) {
		const required = schema.required;
		if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) {
			sink.fail(`Invalid JSON Schema: "required" at ${path} must be an array of property names.`);
		}
	}

	if (schema.additionalProperties !== undefined) {
		const extra = schema.additionalProperties;
		if (extra !== false && extra !== true) {
			sink.fail(
				`Unsupported JSON Schema keyword "additionalProperties" at ${path}: only true or false are supported, got ${JSON.stringify(extra)}.`,
			);
		}
	}

	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) {
			const tuple = schema.items;
			tuple.forEach((sub, i) => {
				checkSchema(sub, childPath(path, i, true), sink);
			});
		} else {
			checkSchema(schema.items, `${path}[*]`, sink);
		}
	}

	for (const keyword of ["oneOf", "anyOf"] as const) {
		const branches = schema[keyword];
		if (branches === undefined) continue;
		if (!Array.isArray(branches) || branches.length === 0) {
			sink.fail(`Invalid JSON Schema: "${keyword}" at ${path} must be a non-empty array of schemas.`);
			continue;
		}
		const branchesList: unknown[] = branches;
		branchesList.forEach((sub, i) => {
			checkSchema(sub, `${path}/${keyword}[${i}]`, sink);
		});
	}

	for (const keyword of ["minimum", "maximum"] as const) {
		if (schema[keyword] !== undefined && typeof schema[keyword] !== "number") {
			sink.fail(`Invalid JSON Schema: "${keyword}" at ${path} must be a number.`);
		}
	}

	for (const keyword of ["minLength", "maxLength"] as const) {
		const bound = schema[keyword];
		if (bound !== undefined && (typeof bound !== "number" || !Number.isInteger(bound) || bound < 0)) {
			sink.fail(`Invalid JSON Schema: "${keyword}" at ${path} must be a non-negative integer.`);
		}
	}

	if (schema.pattern !== undefined) {
		if (typeof schema.pattern !== "string") {
			sink.fail(`Invalid JSON Schema: "pattern" at ${path} must be a string.`);
		} else {
			try {
				new RegExp(schema.pattern);
			} catch (err) {
				sink.fail(
					`Invalid JSON Schema: "pattern" at ${path} is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
		sink.fail(`Invalid JSON Schema: "enum" at ${path} must be an array.`);
	}
}

// ---------------------------------------------------------------------------
// Value pass: check the parsed output against a structurally accepted schema.
// ---------------------------------------------------------------------------

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "object":
			return isPlainObject(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			return true;
	}
}

function validateValue(value: unknown, schema: Record<string, unknown>, path: string, sink: Sink): void {
	if (schema.type !== undefined) {
		const types: string[] = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
		if (!types.some((t) => matchesType(value, t))) {
			sink.fail(`${path}: expected ${types.join(" or ")}, got ${describeValue(value)}`);
			return;
		}
	}

	if (schema.enum !== undefined) {
		const allowed = schema.enum as unknown[];
		if (!allowed.some((option) => deepEqual(value, option))) {
			sink.fail(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
		}
	}

	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			sink.fail(`${path}: ${value} is less than the minimum ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			sink.fail(`${path}: ${value} is greater than the maximum ${schema.maximum}`);
		}
	}

	if (typeof value === "string") {
		const length = [...value].length;
		if (typeof schema.minLength === "number" && length < schema.minLength) {
			sink.fail(`${path}: string of ${length} characters is shorter than minLength ${schema.minLength}`);
		}
		if (typeof schema.maxLength === "number" && length > schema.maxLength) {
			sink.fail(`${path}: string of ${length} characters is longer than maxLength ${schema.maxLength}`);
		}
		if (typeof schema.pattern === "string") {
			if (!new RegExp(schema.pattern).test(value)) {
				sink.fail(`${path}: "${value}" does not match pattern ${schema.pattern}`);
			}
		}
	}

	if (Array.isArray(value)) {
		const items = schema.items;
		if (items === undefined) {
			// nothing else to check
		} else if (Array.isArray(items)) {
			items.forEach((sub, i) => {
				if (i < value.length && isPlainObject(sub)) validateValue(value[i], sub, childPath(path, i, true), sink);
			});
			if (value.length > items.length) {
				sink.fail(
					`${path}: array of ${value.length} items is longer than the ${items.length}-item tuple "items" schema`,
				);
			}
		} else if (isPlainObject(items)) {
			value.forEach((item, i) => {
				validateValue(item, items, childPath(path, i, true), sink);
			});
		}
	}

	if (isPlainObject(value)) {
		const required = schema.required;
		if (Array.isArray(required)) {
			for (const key of required) {
				if (typeof key === "string" && !Object.hasOwn(value, key)) {
					sink.fail(`${path}: missing required property "${key}"`);
				}
			}
		}
		const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
		if (properties) {
			for (const [key, sub] of Object.entries(properties)) {
				if (Object.hasOwn(value, key) && isPlainObject(sub)) {
					validateValue(value[key], sub, childPath(path, key), sink);
				}
			}
		}
		if (schema.additionalProperties === false && properties) {
			for (const key of Object.keys(value)) {
				if (!Object.hasOwn(properties, key)) {
					sink.fail(`${path}: unexpected property "${key}" (additionalProperties is false)`);
				}
			}
		}
	}

	// Union branches: the branch errors are only interesting when nothing matched.
	if (Array.isArray(schema.anyOf)) {
		const branches = schema.anyOf as unknown[];
		const matched = branches.some((sub) => validateSilently(value, sub));
		if (!matched) {
			const reasons = branches.map((sub) => collectErrors(value, sub)).filter((list) => list.length > 0)[0];
			sink.fail(
				`${path}: matches none of the ${branches.length} "anyOf" schemas${reasons ? ` (${reasons[0]})` : ""}`,
			);
		}
	}

	if (Array.isArray(schema.oneOf)) {
		const branches = schema.oneOf as unknown[];
		const matches = branches.filter((sub) => validateSilently(value, sub)).length;
		if (matches === 0) {
			const reasons = branches.map((sub) => collectErrors(value, sub)).filter((list) => list.length > 0)[0];
			sink.fail(
				`${path}: matches none of the ${branches.length} "oneOf" schemas${reasons ? ` (${reasons[0]})` : ""}`,
			);
		} else if (matches > 1) {
			sink.fail(`${path}: matches ${matches} of the ${branches.length} "oneOf" schemas, which must be exclusive`);
		}
	}
}

function validateSilently(value: unknown, schema: unknown): boolean {
	const probe = new Sink();
	if (isPlainObject(schema)) validateValue(value, schema, "$", probe);
	return probe.errors.length === 0;
}

function collectErrors(value: unknown, schema: unknown): string[] {
	const probe = new Sink();
	if (isPlainObject(schema)) validateValue(value, schema, "$", probe);
	return probe.errors;
}

/**
 * Structural check only: does this validator understand the whole schema?
 *
 * Exposed so a caller can reject an unusable schema BEFORE spending a child
 * run on it. Returns one message per unsupported construct (capped), and an
 * empty array when the schema is fully supported.
 */
export function checkSchemaSupport(schema: unknown): string[] {
	const sink = new Sink();
	checkSchema(schema, "$", sink);
	return sink.errors;
}

/**
 * Validate `value` against a JSON Schema subset.
 *
 * Returns `{ ok: false }` with a clear message when the schema itself uses a
 * construct this validator does not implement, so a spec is never silently
 * weaker than its author intended.
 */
export function validateAgainstSchema(value: unknown, schema: unknown): SchemaValidationResult {
	const structuralErrors = checkSchemaSupport(schema);
	if (structuralErrors.length > 0) return { ok: false, errors: structuralErrors };

	const sink = new Sink();
	// The root schema is an object by construction here (checkSchema rejected
	// anything else), so the value pass can run against it directly.
	validateValue(value, schema as Record<string, unknown>, "$", sink);
	return { ok: sink.errors.length === 0, errors: sink.errors };
}

/** Compact single-line summary of validation errors, capped for model-facing text. */
export function formatSchemaErrors(errors: string[]): string {
	if (errors.length === 0) return "no validation errors";
	const shown = errors.slice(0, MAX_ERRORS);
	const rest = errors.length - shown.length;
	const text = shown.map((e, i) => `${i + 1}. ${e}`).join("\n");
	return rest > 0 ? `${text}\n(${rest} more error${rest > 1 ? "s" : ""} omitted)` : text;
}

const JSON_FENCE = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/;

/**
 * Extract the JSON value a child was asked to emit.
 *
 * Tolerates the two shapes models produce most often besides bare JSON: a
 * fenced ```json block, and a JSON object embedded in a short sentence. Bare
 * prose that contains no JSON fails with a message that tells the parent why.
 */
export function extractJsonFromText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: false, error: "output is empty" };

	const direct = tryParse(trimmed);
	if (direct.ok) return direct;

	const fence = JSON_FENCE.exec(trimmed);
	if (fence?.[1]) {
		const inner = tryParse(fence[1].trim());
		if (inner.ok) return inner;
	}

	const start = trimmed.search(/[[{]/);
	if (start >= 0) {
		const opener = trimmed[start];
		const closer = opener === "{" ? "}" : "]";
		const end = trimmed.lastIndexOf(closer);
		if (end > start) {
			const candidate = tryParse(trimmed.slice(start, end + 1));
			if (candidate.ok) return candidate;
		}
	}

	return {
		ok: false,
		error: `output is not valid JSON${fence?.[1] ? " (the fenced code block did not parse)" : ""}: ${direct.error}`,
	};
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Count of top-level properties a schema requires/declares, for the compact
 * result summary. Returns undefined when the schema is absent or not an object
 * schema, so the caller renders nothing rather than `0 props`.
 */
export function summarizeSchema(schema: unknown): { properties: number } | undefined {
	if (!isPlainObject(schema)) return undefined;
	const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
	if (!properties && schema.type !== "object") return undefined;
	return { properties: properties ? Object.keys(properties).length : 0 };
}
