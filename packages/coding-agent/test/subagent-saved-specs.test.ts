/**
 * Saved subagent spec templates: CRUD against the file-backed store under the
 * agent dir. Every test points `ENV_AGENT_DIR` at a fresh temp dir — the real
 * ~/.pi/agent is never touched.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	deleteSpec,
	listSpecs,
	loadSpec,
	SPECS_DIR_NAME,
	saveSpec,
	specsDir,
} from "../src/core/subagent/saved-specs.ts";
import type { SubagentSpec } from "../src/core/subagent/types.ts";

function makeSpec(overrides: Partial<SubagentSpec> = {}): SubagentSpec {
	return {
		role: "code-reviewer",
		instructions: "Review the code for bugs and report findings.",
		model: "anthropic/claude-sonnet-4-20250514",
		tools: ["read", "grep", "bash"],
		cwd: "/work/repo",
		...overrides,
	};
}

describe("saved subagent specs", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	let agentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-saved-specs-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
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

	function specFile(name: string): string {
		return join(specsDir(), `${name}.json`);
	}

	it("listSpecs() returns an empty array when the directory doesn't exist", () => {
		expect(existsSync(specsDir())).toBe(false);
		expect(specsDir()).toBe(join(agentDir as string, SPECS_DIR_NAME));
		expect(listSpecs()).toEqual([]);
	});

	it("saveSpec() creates the directory and writes the file", () => {
		saveSpec("reviewer", makeSpec());

		expect(existsSync(specsDir())).toBe(true);
		expect(existsSync(specFile("reviewer"))).toBe(true);

		const raw = JSON.parse(readFileSync(specFile("reviewer"), "utf8")) as Record<string, unknown>;
		expect(raw).toMatchObject({
			role: "code-reviewer",
			instructions: "Review the code for bugs and report findings.",
			model: "anthropic/claude-sonnet-4-20250514",
			tools: ["read", "grep", "bash"],
			cwd: "/work/repo",
		});
		expect(typeof raw.savedAt).toBe("string");
		expect(Number.isNaN(Date.parse(raw.savedAt as string))).toBe(false);
	});

	it("listSpecs() returns saved specs sorted by name", () => {
		saveSpec("zeta", makeSpec({ role: "zeta" }));
		saveSpec("alpha", makeSpec({ role: "alpha" }));

		const specs = listSpecs();
		expect(specs.map((s) => s.name)).toEqual(["alpha", "zeta"]);
		expect(specs[0]?.spec.role).toBe("alpha");
		expect(typeof specs[0]?.savedAt).toBe("string");
	});

	it("loadSpec() returns the spec without the savedAt field", () => {
		const spec = makeSpec();
		saveSpec("reviewer", spec);

		const loaded = loadSpec("reviewer");
		expect(loaded).toEqual(spec);
		expect(loaded).not.toHaveProperty("savedAt");
		expect(loaded).not.toHaveProperty("sessionFile");
	});

	it("loadSpec() throws for an unknown name", () => {
		expect(() => loadSpec("nope")).toThrowError(/no saved specs found/);
	});

	it("deleteSpec() removes the file", () => {
		saveSpec("reviewer", makeSpec());
		expect(existsSync(specFile("reviewer"))).toBe(true);

		deleteSpec("reviewer");
		expect(existsSync(specFile("reviewer"))).toBe(false);
		expect(listSpecs()).toEqual([]);
	});

	it("deleteSpec() throws for an unknown name", () => {
		expect(() => deleteSpec("nope")).toThrowError(/no saved spec found/);
	});

	it("saveSpec() overwrites an existing spec", () => {
		saveSpec("reviewer", makeSpec({ instructions: "first" }));
		const first = JSON.parse(readFileSync(specFile("reviewer"), "utf8")) as { savedAt: string };

		saveSpec("reviewer", makeSpec({ instructions: "second", tools: ["read"] }));

		const specs = listSpecs();
		expect(specs.length).toBe(1);
		expect(loadSpec("reviewer").instructions).toBe("second");
		expect(loadSpec("reviewer").tools).toEqual(["read"]);
		const raw = JSON.parse(readFileSync(specFile("reviewer"), "utf8")) as { savedAt: string };
		expect(typeof raw.savedAt).toBe("string");
		// The overwrite rewrote the file rather than appending a second entry.
		expect(first.savedAt.length).toBeGreaterThan(0);
	});

	it("rejects names containing path separators", () => {
		expect(() => saveSpec("../escape", makeSpec())).toThrowError(/path separators/);
		expect(() => saveSpec("nested/reviewer", makeSpec())).toThrowError(/path separators/);
		expect(() => saveSpec("nested\\reviewer", makeSpec())).toThrowError(/path separators/);
		expect(() => loadSpec("../escape")).toThrowError(/path separators/);
		expect(() => deleteSpec("nested/reviewer")).toThrowError(/path separators/);
	});

	it("skips corrupt JSON in listSpecs() and warns", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		saveSpec("good", makeSpec({ role: "good" }));
		writeFileSync(specFile("broken"), "{ not json", "utf8");

		const specs = listSpecs();
		expect(specs.map((s) => s.name)).toEqual(["good"]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("broken");
		warn.mockRestore();
	});
});
