/**
 * Tests for src/research-mode.ts — 3x-same-error streak tracker.
 */

import { describe, expect, it, vi } from "vitest";
import { ResearchModeTracker } from "../src/research-mode.ts";

describe("ResearchModeTracker", () => {
	it("does not trigger on first error", () => {
		const notify = vi.fn();
		const tracker = new ResearchModeTracker({ notify, threshold: 3 });
		const fired = tracker.recordToolResult("s1", "bash", true, "ENOENT: no such file", undefined);
		expect(fired).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("does not trigger on second error with same fingerprint", () => {
		const notify = vi.fn();
		const tracker = new ResearchModeTracker({ notify, threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "ENOENT: no such file", undefined);
		const fired = tracker.recordToolResult("s1", "bash", true, "ENOENT: no such file", undefined);
		expect(fired).toBe(false);
	});

	it("triggers on third consecutive same error", () => {
		const notify = vi.fn();
		const tracker = new ResearchModeTracker({ notify, threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "ENOENT: no such file", undefined);
		tracker.recordToolResult("s1", "bash", true, "ENOENT: no such file", undefined);
		const fired = tracker.recordToolResult("s1", "bash", true, "ENOENT: no such file", undefined);
		expect(fired).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("same error 3x on bash"), "warning");
	});

	it("treats formatted-but-equivalent errors as the same fingerprint", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "ENOENT: no such file", undefined);
		tracker.recordToolResult("s1", "bash", true, "ENOENT:  no  such  file\n", undefined);
		// Same core message but with extra padding — still normalised to the
		// same fingerprint (whitespace collapsed, leading/trailing trimmed).
		const fired = tracker.recordToolResult(
			"s1",
			"bash",
			true,
			"  ENOENT: no such file   ",
			undefined,
		);
		expect(fired).toBe(true);
	});

	it("strips the tool name from the fingerprint", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "bash failed: x", undefined);
		tracker.recordToolResult("s1", "bash", true, "bash failed: x", undefined);
		const fired = tracker.recordToolResult("s1", "bash", true, "bash failed: x", undefined);
		expect(fired).toBe(true);
	});

	it("resets the streak on a successful call", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "error 1", undefined);
		tracker.recordToolResult("s1", "bash", true, "error 1", undefined);
		tracker.recordToolResult("s1", "bash", false, undefined, undefined); // success
		const fired = tracker.recordToolResult("s1", "bash", true, "error 1", undefined);
		expect(fired).toBe(false);
	});

	it("resets the streak when the error text changes", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "error A", undefined);
		tracker.recordToolResult("s1", "bash", true, "error A", undefined);
		tracker.recordToolResult("s1", "bash", true, "error B", undefined); // different error → count = 1
		const fired = tracker.recordToolResult("s1", "bash", true, "error B", undefined);
		expect(fired).toBe(false);
	});

	it("does not fire when isError=false even if errorText is set", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.recordToolResult("s1", "bash", false, "ENOENT", undefined);
		tracker.recordToolResult("s1", "bash", false, "ENOENT", undefined);
		const fired = tracker.recordToolResult("s1", "bash", false, "ENOENT", undefined);
		expect(fired).toBe(false);
	});

	it("respects disabled flag set via setDisabled", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.setDisabled("s1", true);
		const fired = tracker.recordToolResult("s1", "bash", true, "x", undefined);
		expect(fired).toBe(false);
	});

	it("reset() clears state for a session", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "x", undefined);
		tracker.recordToolResult("s1", "bash", true, "x", undefined);
		tracker.reset("s1");
		const fired = tracker.recordToolResult("s1", "bash", true, "x", undefined);
		expect(fired).toBe(false);
	});

	it("uses default threshold of 3 when not specified", () => {
		const notify = vi.fn();
		const tracker = new ResearchModeTracker({ notify });
		tracker.recordToolResult("s1", "bash", true, "x", undefined);
		tracker.recordToolResult("s1", "bash", true, "x", undefined);
		const fired = tracker.recordToolResult("s1", "bash", true, "x", undefined);
		expect(fired).toBe(true);
	});

	it("isolates state across sessions", () => {
		const tracker = new ResearchModeTracker({ threshold: 3 });
		tracker.recordToolResult("s1", "bash", true, "x", undefined);
		tracker.recordToolResult("s1", "bash", true, "x", undefined);
		// s2 is independent — its first call shouldn't trigger
		const fired = tracker.recordToolResult("s2", "bash", true, "x", undefined);
		expect(fired).toBe(false);
	});
});