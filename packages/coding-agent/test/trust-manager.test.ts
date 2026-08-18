import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireInProcessTrustLock,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".pi", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".pi", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".pi", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".pi"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});
});

describe("acquireInProcessTrustLock (Bun migration, issue #78)", () => {
	const uniquePath = (label: string): string =>
		join(tmpdir(), `trust-lock-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

	it("throws when isBun is false so the in-process lock is never used on Node", () => {
		expect(() => acquireInProcessTrustLock(uniquePath("node"), false)).toThrow(/Bun runtime path/);
	});

	it("acquires and releases a lock on a path", () => {
		const path = uniquePath("basic");
		const release = acquireInProcessTrustLock(path, true);
		expect(typeof release).toBe("function");
		release();
	});

	it("is reentrant: nested acquires on the same path both succeed", () => {
		const path = uniquePath("reentrant");
		const release1 = acquireInProcessTrustLock(path, true);
		const release2 = acquireInProcessTrustLock(path, true);
		release1();
		// Refcount is still 1, so the path is still locked.
		release2();
		// After both releases, the path is unlocked.
	});

	it("release is idempotent and cannot be called twice", () => {
		const path = uniquePath("idempotent");
		const release = acquireInProcessTrustLock(path, true);
		release();
		// Calling release a second time must not throw and must not
		// drive the refcount negative.
		release();
	});

	it("keeps locks on different paths independent", () => {
		const pathA = uniquePath("isolated-a");
		const pathB = uniquePath("isolated-b");
		const releaseA = acquireInProcessTrustLock(pathA, true);
		const releaseB = acquireInProcessTrustLock(pathB, true);
		releaseA();
		releaseB();
	});
});
