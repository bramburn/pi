import { describe, expect, it } from "vitest";
import {
	extractJsonFromText,
	formatSchemaErrors,
	summarizeSchema,
	validateAgainstSchema,
} from "../src/core/subagent/schema-validate.ts";

describe("subagent schema validator: supported keywords", () => {
	it("accepts a matching object", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "integer", minimum: 0, maximum: 130 },
				tags: { type: "array", items: { type: "string" } },
				status: { type: "string", enum: ["ok", "warn", "fail"] },
			},
			required: ["name", "age"],
			additionalProperties: false,
		};
		const result = validateAgainstSchema({ name: "t", age: 3, tags: ["a"], status: "ok" }, schema);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("reports missing required properties with a JSON-ish path", () => {
		const result = validateAgainstSchema(
			{ tags: [] },
			{
				type: "object",
				properties: { name: { type: "string" }, tags: { type: "array" } },
				required: ["name"],
			},
		);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain('$: missing required property "name"');
	});

	it("reports type mismatches per property", () => {
		const result = validateAgainstSchema(
			{ name: 5, nested: { flag: "yes" } },
			{
				type: "object",
				properties: {
					name: { type: "string" },
					nested: { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
				},
				required: ["name"],
			},
		);
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("$.name: expected string, got number");
		expect(result.errors).toContain("$.nested.flag: expected boolean, got string");
	});

	it("rejects unknown properties when additionalProperties is false", () => {
		const result = validateAgainstSchema(
			{ a: 1, b: 2 },
			{ type: "object", properties: { a: { type: "number" } }, additionalProperties: false },
		);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain('unexpected property "b"');
	});

	it("allows unknown properties when additionalProperties is omitted", () => {
		const result = validateAgainstSchema({ a: 1, b: 2 }, { type: "object", properties: { a: { type: "number" } } });
		expect(result.ok).toBe(true);
	});

	it("validates array items with a single schema", () => {
		const result = validateAgainstSchema(["a", 3, "c"], { type: "array", items: { type: "string" } });
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("$[1]: expected string, got number");
	});

	it("validates tuple items positionally", () => {
		const schema = { type: "array", items: [{ type: "string" }, { type: "number" }] };
		expect(validateAgainstSchema(["a", 1], schema).ok).toBe(true);
		expect(validateAgainstSchema([1, "a"], schema).ok).toBe(false);
		const tooLong = validateAgainstSchema(["a", 1, 2], schema);
		expect(tooLong.ok).toBe(false);
		expect(tooLong.errors.join("\n")).toContain("tuple");
	});

	it("checks enum membership with deep equality", () => {
		const schema = { type: "string", enum: ["a", "b"] };
		expect(validateAgainstSchema("a", schema).ok).toBe(true);
		expect(validateAgainstSchema("c", schema).ok).toBe(false);
		expect(validateAgainstSchema({ ok: true }, { enum: [{ ok: true }, 2] }).ok).toBe(true);
		expect(validateAgainstSchema({ ok: false }, { enum: [{ ok: true }, 2] }).ok).toBe(false);
	});

	it("checks numeric bounds", () => {
		const schema = { type: "number", minimum: 1, maximum: 10 };
		expect(validateAgainstSchema(1, schema).ok).toBe(true);
		expect(validateAgainstSchema(0.5, schema).ok).toBe(false);
		expect(validateAgainstSchema(11, schema).ok).toBe(false);
	});

	it("checks string length and pattern", () => {
		const schema = { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" };
		expect(validateAgainstSchema("abc", schema).ok).toBe(true);
		expect(validateAgainstSchema("a", schema).ok).toBe(false);
		expect(validateAgainstSchema("abcdef", schema).ok).toBe(false);
		expect(validateAgainstSchema("ABC", schema).ok).toBe(false);
	});

	it("counts string length in code points, not UTF-16 units", () => {
		expect(validateAgainstSchema("😀😀😀", { type: "string", maxLength: 3 }).ok).toBe(true);
		expect(validateAgainstSchema("😀😀😀", { type: "string", minLength: 4 }).ok).toBe(false);
	});

	it("supports union type arrays and null", () => {
		const schema = { type: ["string", "null"] };
		expect(validateAgainstSchema("x", schema).ok).toBe(true);
		expect(validateAgainstSchema(null, schema).ok).toBe(true);
		expect(validateAgainstSchema(1, schema).ok).toBe(false);
	});

	it("accepts anyOf when at least one branch matches", () => {
		const schema = { anyOf: [{ type: "string" }, { type: "integer", minimum: 5 }] };
		expect(validateAgainstSchema("x", schema).ok).toBe(true);
		expect(validateAgainstSchema(7, schema).ok).toBe(true);
		const failed = validateAgainstSchema(2, schema);
		expect(failed.ok).toBe(false);
		expect(failed.errors.join("\n")).toContain("anyOf");
	});

	it("requires exactly one oneOf branch to match", () => {
		const schema = {
			oneOf: [
				{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
				{ type: "object", properties: { b: { type: "string" } }, required: ["b"] },
			],
		};
		expect(validateAgainstSchema({ a: "x" }, schema).ok).toBe(true);
		expect(validateAgainstSchema({ a: "x", b: "y" }, schema).ok).toBe(false);
		expect(validateAgainstSchema({}, schema).ok).toBe(false);
	});

	it("ignores annotation keywords", () => {
		const result = validateAgainstSchema(
			{ a: 1 },
			{
				$schema: "https://json-schema.org/draft/2020-12/schema",
				$id: "urn:x",
				title: "Thing",
				description: "docs",
				default: {},
				examples: [{ a: 1 }],
				type: "object",
				properties: { a: { type: "integer", description: "count" } },
				required: ["a"],
			},
		);
		expect(result.ok).toBe(true);
	});

	it("caps the number of reported errors", () => {
		const schema = {
			type: "object",
			properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, { type: "string" }])),
			additionalProperties: false,
		};
		const value = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
		const result = validateAgainstSchema(value, schema);
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeLessThanOrEqual(20);
		expect(formatSchemaErrors(result.errors)).toMatch(/^\d+\. \$\./);
	});

	it("formats errors as a numbered list", () => {
		expect(formatSchemaErrors([])).toBe("no validation errors");
		expect(formatSchemaErrors(["a", "b"])).toBe("1. a\n2. b");
	});
});

describe("subagent schema validator: unsupported constructs fail loudly", () => {
	it("rejects allOf", () => {
		const result = validateAgainstSchema(1, { allOf: [{ type: "number" }] });
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain('Unsupported JSON Schema keyword "allOf"');
	});

	it.each(["$ref", "not", "if", "then", "patternProperties", "minItems", "exclusiveMinimum", "format", "const"])(
		"rejects %s",
		(keyword) => {
			const result = validateAgainstSchema("x", { type: "string", [keyword]: {} });
			expect(result.ok).toBe(false);
			expect(result.errors.join("\n")).toContain(`Unsupported JSON Schema keyword "${keyword}"`);
		},
	);

	it("names the nested path of an unsupported keyword", () => {
		const result = validateAgainstSchema(
			{ user: { id: 1 } },
			{
				type: "object",
				properties: { user: { type: "object", properties: { id: { type: "integer", const: 1 } } } },
			},
		);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("$.user.id");
	});

	it("rejects a non-object schema", () => {
		expect(validateAgainstSchema(1, true).ok).toBe(false);
		expect(validateAgainstSchema(1, "string").ok).toBe(false);
		expect(validateAgainstSchema(1, undefined).ok).toBe(false);
	});

	it("rejects an additionalProperties schema form", () => {
		const result = validateAgainstSchema({}, { type: "object", additionalProperties: { type: "string" } });
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("additionalProperties");
	});

	it("rejects an invalid pattern instead of silently skipping it", () => {
		const result = validateAgainstSchema("a", { type: "string", pattern: "([a-z" });
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("not a valid regular expression");
	});

	it("does not validate values against a schema it cannot honor", () => {
		// allOf alone would otherwise pass: the structural check must run first.
		const result = validateAgainstSchema("x", { allOf: [{ type: "number" }] });
		expect(result.errors.join("\n")).not.toContain("expected");
	});
});

describe("extractJsonFromText", () => {
	it("parses bare JSON", () => {
		expect(extractJsonFromText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
		expect(extractJsonFromText("  [1, 2] ")).toEqual({ ok: true, value: [1, 2] });
	});

	it("parses a fenced json block", () => {
		expect(extractJsonFromText('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ ok: true, value: { a: 1 } });
	});

	it("parses JSON embedded in prose", () => {
		expect(extractJsonFromText('Result: {"a":1,"b":[2,3]} end.')).toEqual({
			ok: true,
			value: { a: 1, b: [2, 3] },
		});
	});

	it("fails with a clear message on prose", () => {
		const result = extractJsonFromText("all good, nothing to report");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("not valid JSON");
	});

	it("fails on empty output", () => {
		expect(extractJsonFromText("   ").ok).toBe(false);
	});
});

describe("summarizeSchema", () => {
	it("counts top-level properties", () => {
		expect(summarizeSchema({ type: "object", properties: { a: {}, b: {} } })).toEqual({ properties: 2 });
	});

	it("returns undefined for non-object or absent schemas", () => {
		expect(summarizeSchema(undefined)).toBeUndefined();
		expect(summarizeSchema({ type: "array", items: {} })).toBeUndefined();
	});
});
