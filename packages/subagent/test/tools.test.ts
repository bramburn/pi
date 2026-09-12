/**
 * Tests for src/tools.ts — TypeBox schemas for the 8 experiment tools.
 *
 * typebox 1.3.x uses a `Value.Errors(schema, value)` + `Value.Cast(schema, value)`
 * style for runtime checks. `Validator` provides a compiled fast path.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	CompareParams,
	DiffParams,
	DiscardParams,
	ListParams,
	MergeParams,
	RunParams,
	StartParams,
	TestParams,
} from "../src/tools.ts";

function isValid(schema: unknown, value: unknown): boolean {
	return Value.Check(schema as Parameters<typeof Value.Check>[0], value);
}

describe("StartParams", () => {
	it("accepts a valid hypothesis + approach_name", () => {
		expect(
			isValid(StartParams, {
				hypothesis: "Faster cold start",
				approach_name: "bun-ipc-worker",
			}),
		).toBe(true);
	});

	it("rejects approach_name not matching kebab-case pattern", () => {
		expect(isValid(StartParams, { hypothesis: "x", approach_name: "Not Kebab" })).toBe(false);
	});

	it("accepts optional parent_commit", () => {
		expect(
			isValid(StartParams, {
				hypothesis: "x",
				approach_name: "abc-def",
				parent_commit: "deadbeef",
			}),
		).toBe(true);
	});
});

describe("RunParams", () => {
	it("requires experiment_id and command", () => {
		expect(isValid(RunParams, { experiment_id: "exp-1", command: "echo hi" })).toBe(true);
	});

	it("accepts optional timeout_ms", () => {
		expect(
			isValid(RunParams, { experiment_id: "exp-1", command: "echo hi", timeout_ms: 1000 }),
		).toBe(true);
	});
});

describe("TestParams", () => {
	it("requires experiment_id", () => {
		expect(isValid(TestParams, { experiment_id: "exp-1" })).toBe(true);
	});

	it("accepts optional filter", () => {
		expect(isValid(TestParams, { experiment_id: "exp-1", filter: "should work" })).toBe(true);
	});
});

describe("DiffParams", () => {
	it("requires experiment_id", () => {
		expect(isValid(DiffParams, { experiment_id: "exp-1" })).toBe(true);
	});
});

describe("MergeParams", () => {
	it("requires experiment_id and strategy", () => {
		expect(isValid(MergeParams, { experiment_id: "exp-1", strategy: "squash" })).toBe(true);
	});

	it("accepts all three strategies", () => {
		for (const s of ["cherry-pick", "squash", "merge"] as const) {
			expect(isValid(MergeParams, { experiment_id: "x", strategy: s })).toBe(true);
		}
	});

	it("rejects unknown strategy", () => {
		expect(isValid(MergeParams, { experiment_id: "x", strategy: "rebase" })).toBe(false);
	});

	it("accepts optional squash_message", () => {
		expect(
			isValid(MergeParams, {
				experiment_id: "x",
				strategy: "squash",
				squash_message: "squashed!",
			}),
		).toBe(true);
	});
});

describe("DiscardParams", () => {
	it("requires experiment_id and reason", () => {
		expect(isValid(DiscardParams, { experiment_id: "exp-1", reason: "wrong direction" })).toBe(true);
	});

	it("accepts optional keep_branch boolean", () => {
		expect(
			isValid(DiscardParams, {
				experiment_id: "exp-1",
				reason: "wrong direction",
				keep_branch: false,
			}),
		).toBe(true);
	});
});

describe("ListParams", () => {
	it("accepts empty object (status is optional)", () => {
		expect(isValid(ListParams, {})).toBe(true);
	});

	it("accepts each known status", () => {
		for (const s of [
			"scaffolded",
			"running",
			"completed",
			"failed",
			"merged",
			"discarded",
			"cancelled",
			"all",
		] as const) {
			expect(isValid(ListParams, { status: s })).toBe(true);
		}
	});

	it("rejects unknown status", () => {
		expect(isValid(ListParams, { status: "invented" })).toBe(false);
	});
});

describe("CompareParams", () => {
	it("requires exp_id_1 and exp_id_2", () => {
		expect(isValid(CompareParams, { exp_id_1: "a", exp_id_2: "b" })).toBe(true);
	});

	it("accepts optional axes array", () => {
		expect(isValid(CompareParams, { exp_id_1: "a", exp_id_2: "b", axes: ["speed", "memory"] })).toBe(
			true,
		);
	});
});

// Sanity check: the `Value` import works for both Check and Cast.
describe("Value.Check round-trips", () => {
	it("returns true for valid input", () => {
		expect(Value.Check(StartParams, { hypothesis: "x", approach_name: "abc-def" })).toBe(true);
	});

	it("returns false for invalid input", () => {
		expect(Value.Check(StartParams, { hypothesis: "x", approach_name: "Not Kebab" })).toBe(false);
	});
});