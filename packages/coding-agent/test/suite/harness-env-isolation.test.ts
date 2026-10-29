import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubAmbientPiEnv } from "./harness.ts";

// Leaked before any hook runs, the way a developer's shell (or a pi session
// running the suite) exports these. The harness must scrub it.
process.env.QI_EXAMPLE_LEAK = "leaked at import time";

describe("harness ambient PI_* isolation", () => {
	// Deliberately not in afterEach: the leaked value has to survive into the next
	// test so "scrubs again before each following test" can observe the re-scrub.
	afterAll(() => {
		delete process.env.QI_EXAMPLE_LEAK;
	});

	afterEach(() => {
		delete process.env.QI_MODEL;
		delete process.env.PILOT_MODE;
		delete process.env.PIZZA_TOPPING;
	});

	it("scrubs PI_* that leaked in before any test ran", () => {
		expect(process.env.QI_EXAMPLE_LEAK).toBeUndefined();
		// Re-leak it so the next test can prove the scrub runs per test, not once.
		process.env.QI_EXAMPLE_LEAK = "leaked by the previous test";
	});

	it("scrubs again before each following test", () => {
		expect(process.env.QI_EXAMPLE_LEAK).toBeUndefined();
	});

	it("deletes the PI_ family but keeps QI_OFFLINE and non-PI names", () => {
		process.env.QI_MODEL = "leaked";
		process.env.QI_EXAMPLE_LEAK = "leaked";
		process.env.QI_OFFLINE = "1";
		// Near misses: "PILOT_MODE" starts with PI but not "PI_", "PIZZA_TOPPING"
		// is unrelated. Neither belongs to the family under test.
		process.env.PILOT_MODE = "keep";
		process.env.PIZZA_TOPPING = "keep";

		scrubAmbientPiEnv();

		expect(process.env.QI_MODEL).toBeUndefined();
		expect(process.env.QI_EXAMPLE_LEAK).toBeUndefined();
		// QI_OFFLINE is the vitest config's network guard; scrubbing it would let
		// tests reach the real API.
		expect(process.env.QI_OFFLINE).toBe("1");
		expect(process.env.PILOT_MODE).toBe("keep");
		expect(process.env.PIZZA_TOPPING).toBe("keep");
	});

	// Nested so the hook below only covers its own test. It registers after the
	// harness scrub (root-level hooks run first), so the value it sets has to
	// survive into the test body — suite tests rely on that when they set
	// QI_TEST_ANALYTICS_HOME or QI_OFFLINE themselves and restore them later.
	describe("env a test sets in its own hooks", () => {
		beforeEach(() => {
			process.env.QI_EXAMPLE_LEAK = "set by the test's own hook";
		});

		it("wins over the scrub", () => {
			expect(process.env.QI_EXAMPLE_LEAK).toBe("set by the test's own hook");
		});
	});
});
