import { describe, expect, it } from "vitest";
import { formatContractBadges, formatContractSummary, getContractBadges } from "../src/core/subagent/render.ts";
import type { SubagentGateOutcome, SubagentResult, SubagentUsage } from "../src/core/subagent/types.ts";
import { createEmptyUsage } from "../src/core/subagent/types.ts";

/**
 * Contract badges are the only place a reader learns that a green ✓ was earned
 * through a host gate and a validated JSON payload rather than prose, so the
 * badge wording is worth pinning.
 */

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	const usage: SubagentUsage = createEmptyUsage();
	return {
		role: "builder",
		task: "do the thing",
		finalOutput: "done",
		messages: [],
		exitCode: 0,
		aborted: false,
		stderr: "",
		usage,
		stopReason: "endTurn",
		model: "some/model",
		...overrides,
	};
}

function passedGate(overrides: Partial<SubagentGateOutcome> = {}): SubagentGateOutcome {
	return {
		command: "bun run check",
		cwd: "/work",
		passed: true,
		exitCode: 0,
		stdout: "ok",
		stderr: "",
		durationMs: 1200,
		timedOut: false,
		cancelled: false,
		truncated: false,
		...overrides,
	};
}

describe("subagent contract badges", () => {
	it("shows nothing for a result with no declared contract", () => {
		expect(formatContractBadges(makeResult())).toBe("");
		expect(getContractBadges(makeResult())).toEqual([]);
	});

	it("shows nothing while a child is still running", () => {
		const running = makeResult({
			exitCode: -1,
			gate: passedGate(),
			outputValidation: { status: "passed", errors: [] },
		});
		expect(formatContractBadges(running)).toBe("");
	});

	it("marks a validated payload and a passing gate with durations", () => {
		const result = makeResult({
			outputValidation: { status: "passed", errors: [] },
			gate: passedGate({ durationMs: 1200 }),
		});
		expect(formatContractBadges(result)).toBe("json ✓ gate ✓ 1.2s");
	});

	it("counts schema errors and reports sub-second gate durations in ms", () => {
		const result = makeResult({
			outputValidation: { status: "failed", errors: ["$.a: expected string", "$.b: expected number"] },
			gate: passedGate({ passed: false, exitCode: 1, durationMs: 45 }),
		});
		expect(formatContractBadges(result)).toBe("json ✗ 2 gate ✗ exit 1");
	});

	it("says parse when the payload was not JSON at all", () => {
		const result = makeResult({
			outputValidation: { status: "failed", errors: [], parseError: "no JSON object found" },
		});
		expect(formatContractBadges(result)).toBe("json ✗ parse");
	});

	it("names the reason a gate never ran instead of staying silent", () => {
		expect(
			formatContractBadges(
				makeResult({
					gate: passedGate({ passed: false, skipped: "schema-failed", exitCode: -1, stdout: "", stderr: "" }),
				}),
			),
		).toBe("gate ⊘ schema-failed");
		expect(
			formatContractBadges(
				makeResult({
					gate: passedGate({ passed: false, skipped: "child-failed", exitCode: -1, stdout: "", stderr: "" }),
				}),
			),
		).toBe("gate ⊘ child-failed");
	});

	it("distinguishes a timeout from a cancellation and a non-zero exit", () => {
		expect(
			formatContractBadges(makeResult({ gate: passedGate({ passed: false, timedOut: true, exitCode: -1 }) })),
		).toContain("gate ⏱");
		expect(
			formatContractBadges(makeResult({ gate: passedGate({ passed: false, cancelled: true, exitCode: -1 }) })),
		).toBe("gate ⊘ cancelled");
	});

	it("summarises a batch over the contracts that actually ran", () => {
		const batch = [
			makeResult({ outputValidation: { status: "passed", errors: [] }, gate: passedGate() }),
			makeResult({ role: "tester", outputValidation: { status: "failed", errors: ["$.ok: expected boolean"] } }),
			makeResult({
				role: "reviewer",
				gate: passedGate({ passed: false, skipped: "child-failed", exitCode: -1 }),
			}),
		];
		// The reviewer's skipped gate is excluded from the denominator, so the
		// gate column reads 1/1 rather than 1/2.
		expect(formatContractSummary(batch)).toBe("json 1/2 gate 1/1");
	});

	it("returns an empty summary when no task declared a contract", () => {
		expect(formatContractSummary([makeResult(), makeResult({ role: "tester" })])).toBe("");
	});
});
