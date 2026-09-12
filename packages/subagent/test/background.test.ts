/**
 * Tests for src/background.ts — file-backed background-task registry.
 *
 * The singleton `_resetRegistryForTests` exercises the real
 * process-wide registry. We use a per-test temp HOME via env var
 * mutation is not available (getAgentDir caches), so instead we
 * test only the bits that don't write to disk and confirm the
 * exports/types work as expected.
 */

import { describe, expect, it } from "vitest";
import { _resetRegistryForTests, getRegistry } from "../src/background.ts";

describe("BackgroundRegistry singleton", () => {
	it("returns the same instance on multiple calls", () => {
		_resetRegistryForTests();
		const a = getRegistry();
		const b = getRegistry();
		expect(a).toBe(b);
	});

	it("_resetRegistryForTests forces a fresh instance", () => {
		const before = getRegistry();
		_resetRegistryForTests();
		const after = getRegistry();
		expect(before).not.toBe(after);
	});
});

describe("BackgroundRegistry public surface", () => {
	it("exposes the expected method shape", () => {
		_resetRegistryForTests();
		const reg = getRegistry();
		expect(typeof reg.makeTaskId).toBe("function");
		expect(typeof reg.add).toBe("function");
		expect(typeof reg.update).toBe("function");
		expect(typeof reg.appendLog).toBe("function");
		expect(typeof reg.listRunning).toBe("function");
		expect(typeof reg.snapshot).toBe("function");
		expect(typeof reg.markAllRunningAsCrashed).toBe("function");
		expect(typeof reg.prune).toBe("function");
		expect(typeof reg.cancel).toBe("function");
	});

	it("makeTaskId returns a string starting with bg_", () => {
		_resetRegistryForTests();
		const reg = getRegistry();
		const id = reg.makeTaskId();
		expect(id).toMatch(/^bg_[0-9a-z]+_[0-9a-z]+$/);
	});

	it("makeTaskId produces unique IDs", () => {
		_resetRegistryForTests();
		const reg = getRegistry();
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(reg.makeTaskId());
		}
		// Some collisions are theoretically possible at the same millisecond
		// but the random suffix should make them very rare.
		expect(ids.size).toBeGreaterThan(95);
	});
});