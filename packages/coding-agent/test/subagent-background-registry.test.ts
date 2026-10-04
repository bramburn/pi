/**
 * Background registry on a fresh agent dir (2.7 live-smoke regression): the
 * first `add()` used to throw ENOENT because `withLock` opened the lock file
 * before the `subagent-bg/` directory existed. Unit tests missed it because
 * they stub the registry object; the live smoke hit the real singleton.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundRegistryForTests,
	BG_DIR_NAME,
	BG_REGISTRY_FILE,
	getBackgroundRegistry,
} from "../src/core/subagent/background.ts";

describe("background registry on a fresh agent dir", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	let agentDir: string | undefined;

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (agentDir && existsSync(agentDir)) {
			rmSync(agentDir, { recursive: true, force: true });
		}
		agentDir = undefined;
	});

	it("creates the subagent-bg directory on first write instead of failing", () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-registry-"));
		// Fresh agent dir: no subagent-bg/ yet.
		process.env[ENV_AGENT_DIR] = agentDir;
		_resetBackgroundRegistryForTests();

		const registry = getBackgroundRegistry();
		const now = new Date().toISOString();
		expect(() =>
			registry.add({
				id: "bg_test_1",
				kind: "pi-subprocess",
				mode: "single",
				role: "scout",
				label: "scout (background)",
				task: "say something",
				status: "running",
				startedAt: now,
				lastEventAt: now,
				lastOutput: "",
				cwd: agentDir as string,
			}),
		).not.toThrow();

		expect(existsSync(join(agentDir as string, BG_DIR_NAME, BG_REGISTRY_FILE))).toBe(true);
		expect(registry.snapshot().tasks.map((t) => t.id)).toEqual(["bg_test_1"]);
	});
});
