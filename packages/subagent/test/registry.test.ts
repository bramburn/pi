/**
 * Tests for src/registry.ts — file-backed experiment registry.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addExperiment,
	type ExperimentRow,
	experimentDir,
	experimentsDir,
	getExperiment,
	LOCK_FILE_NAME,
	listExperiments,
	makeExperimentId,
	REGISTRY_VERSION,
	readRegistry,
	updateExperiment,
	withWriteLock,
} from "../src/registry.ts";

let repoRoot: string;

beforeEach(() => {
	repoRoot = mkdtempSync(join(tmpdir(), "pi-subagent-registry-test-"));
});

afterEach(() => {
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

function makeRow(overrides: Partial<ExperimentRow> = {}): ExperimentRow {
	const now = new Date().toISOString();
	return {
		id: "exp-test",
		hypothesis: "h",
		approach: "a",
		worktreePath: "/tmp/wt",
		branch: "exp/a",
		parentCommit: "abc123",
		startedInCwd: repoRoot,
		status: "scaffolded",
		result: {},
		merged: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("experimentsDir + experimentDir + logPath", () => {
	it("creates the .pi-experiments directory if missing", () => {
		const dir = experimentsDir(repoRoot);
		expect(dir).toBe(join(repoRoot, ".pi-experiments"));
		expect(existsSync(dir)).toBe(true);
	});

	it("returns experimentDir = <experimentsDir>/<id>", () => {
		const dir = experimentDir(repoRoot, "exp-xyz");
		expect(dir).toBe(join(repoRoot, ".pi-experiments", "exp-xyz"));
	});
});

describe("readRegistry", () => {
	it("returns empty registry when file does not exist", () => {
		const reg = readRegistry(repoRoot);
		expect(reg.version).toBe(REGISTRY_VERSION);
		expect(reg.experiments).toEqual([]);
	});

	it("returns empty registry when JSON is corrupt", () => {
		const dir = experimentsDir(repoRoot);
		writeFileSync(join(dir, "registry.json"), "{not valid json", "utf-8");
		const reg = readRegistry(repoRoot);
		expect(reg.experiments).toEqual([]);
	});

	it("returns empty registry when experiments key is missing", () => {
		const dir = experimentsDir(repoRoot);
		writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 1 }), "utf-8");
		const reg = readRegistry(repoRoot);
		expect(reg.experiments).toEqual([]);
	});

	it("returns empty registry when version mismatch", () => {
		const dir = experimentsDir(repoRoot);
		writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 999, experiments: [{ id: "x" }] }), "utf-8");
		const reg = readRegistry(repoRoot);
		expect(reg.experiments).toEqual([]);
	});

	it("round-trips a valid registry", () => {
		const dir = experimentsDir(repoRoot);
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({
				version: REGISTRY_VERSION,
				experiments: [{ id: "y", status: "running", result: {} }],
			}),
			"utf-8",
		);
		const reg = readRegistry(repoRoot);
		expect(reg.experiments).toHaveLength(1);
		expect(reg.experiments[0]?.id).toBe("y");
	});
});

describe("addExperiment", () => {
	it("appends a new row", () => {
		const row = makeRow({ id: "exp-1" });
		const added = addExperiment(repoRoot, row);
		expect(added.id).toBe("exp-1");
		const reg = readRegistry(repoRoot);
		expect(reg.experiments).toHaveLength(1);
		expect(reg.experiments[0]?.id).toBe("exp-1");
	});

	it("writes atomically via tmp file", () => {
		addExperiment(repoRoot, makeRow({ id: "exp-2" }));
		const dir = experimentsDir(repoRoot);
		// the .tmp file should not remain after the rename
		expect(existsSync(join(dir, "registry.json.tmp"))).toBe(false);
		expect(existsSync(join(dir, "registry.json"))).toBe(true);
	});
});

describe("updateExperiment", () => {
	it("updates an existing row by id", () => {
		addExperiment(repoRoot, makeRow({ id: "exp-3", status: "scaffolded" }));
		const updated = updateExperiment(repoRoot, "exp-3", { status: "running" });
		expect(updated?.status).toBe("running");
		expect(updated?.id).toBe("exp-3");
		expect(updated?.updatedAt).toBeDefined();
		expect(typeof updated?.updatedAt).toBe("string");
	});

	it("returns null when id is not found", () => {
		const result = updateExperiment(repoRoot, "does-not-exist", { status: "running" });
		expect(result).toBeNull();
	});

	it("does not allow changing the id", () => {
		addExperiment(repoRoot, makeRow({ id: "exp-4" }));
		const updated = updateExperiment(repoRoot, "exp-4", { id: "different" } as unknown as Partial<ExperimentRow>);
		expect(updated?.id).toBe("exp-4");
	});
});

describe("getExperiment", () => {
	it("returns the row when present", () => {
		addExperiment(repoRoot, makeRow({ id: "exp-5" }));
		const row = getExperiment(repoRoot, "exp-5");
		expect(row?.id).toBe("exp-5");
	});

	it("returns null when absent", () => {
		expect(getExperiment(repoRoot, "missing")).toBeNull();
	});
});

describe("listExperiments", () => {
	it("returns all when no status filter", () => {
		addExperiment(repoRoot, makeRow({ id: "a", status: "running" }));
		addExperiment(repoRoot, makeRow({ id: "b", status: "completed" }));
		expect(listExperiments(repoRoot).map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("filters by status", () => {
		addExperiment(repoRoot, makeRow({ id: "a", status: "running" }));
		addExperiment(repoRoot, makeRow({ id: "b", status: "completed" }));
		expect(listExperiments(repoRoot, "completed").map((r) => r.id)).toEqual(["b"]);
	});

	it("treats 'all' as no filter", () => {
		addExperiment(repoRoot, makeRow({ id: "a", status: "running" }));
		addExperiment(repoRoot, makeRow({ id: "b", status: "completed" }));
		expect(listExperiments(repoRoot, "all").map((r) => r.id)).toEqual(["a", "b"]);
	});
});

describe("makeExperimentId", () => {
	it("prefixes with exp-<timestamp>-<slug>", () => {
		const id = makeExperimentId("My Approach!", new Date("2026-09-12T10:00:00Z"));
		expect(id).toMatch(/^exp-\d{14}-my-approach$/);
	});

	it("handles empty slug gracefully", () => {
		const id = makeExperimentId("!!!", new Date("2026-09-12T10:00:00Z"));
		expect(id.startsWith("exp-")).toBe(true);
	});
});

describe("withWriteLock", () => {
	it("acquires lock and releases it", () => {
		const result = withWriteLock(repoRoot, (reg) => {
			expect(reg.experiments).toEqual([]);
			reg.experiments.push(makeRow({ id: "lock-1" }));
			return { next: reg, result: "ok" as const };
		});
		expect(result).toBe("ok");
		const after = readRegistry(repoRoot);
		expect(after.experiments).toHaveLength(1);
	});

	it("removes lock file after release", () => {
		withWriteLock(repoRoot, (reg) => ({ next: reg, result: null }));
		expect(existsSync(join(experimentsDir(repoRoot), LOCK_FILE_NAME))).toBe(false);
	});

	it("persists the next registry to disk", () => {
		withWriteLock(repoRoot, (reg) => {
			reg.experiments.push(makeRow({ id: "writelock-1" }));
			return { next: reg, result: null };
		});
		const fileContents = readFileSync(join(experimentsDir(repoRoot), "registry.json"), "utf-8");
		expect(fileContents).toContain("writelock-1");
	});
});
