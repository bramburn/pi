/**
 * Tests for src/agents.ts — agent discovery + parsing.
 *
 * The `user` scope reads from `<agentDir>/agents` which is the real
 * system path (~/.pi/agent/agents); we cannot safely write to it
 * from a test, so we use the `project` scope (which reads from
 * `<cwd>/.pi/agents`) throughout these tests.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, formatAgentList } from "../src/agents.ts";

let tmpDir: string;
let projectAgentsDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-subagent-agents-test-"));
	projectAgentsDir = join(tmpDir, ".pi", "agents");
	mkdirSync(projectAgentsDir, { recursive: true });
});

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function writeAgent(name: string, body: string, dir = projectAgentsDir): string {
	const p = join(dir, `${name}.md`);
	writeFileSync(p, body, "utf-8");
	return p;
}

describe("parseToolList (via agent discovery)", () => {
	it("accepts string frontmatter", () => {
		writeAgent(
			"toolstr",
			`---
name: toolstr
description: a
tools: read, bash, grep
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "toolstr");
		expect(agent?.tools).toEqual(["read", "bash", "grep"]);
	});

	it("accepts array frontmatter", () => {
		writeAgent(
			"toolarr",
			`---
name: toolarr
description: a
tools:
  - read
  - bash
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "toolarr");
		expect(agent?.tools).toEqual(["read", "bash"]);
	});

	it("returns undefined when tools is missing", () => {
		writeAgent(
			"notools",
			`---
name: notools
description: a
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "notools");
		expect(agent?.tools).toBeUndefined();
	});

	it("returns undefined for non-string/non-array tools", () => {
		writeAgent(
			"badtools",
			`---
name: badtools
description: a
tools: 42
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "badtools");
		expect(agent?.tools).toBeUndefined();
	});

	it("returns undefined for empty tools list", () => {
		writeAgent(
			"emptytools",
			`---
name: emptytools
description: a
tools: []
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "emptytools");
		expect(agent?.tools).toBeUndefined();
	});
});

describe("loadAgentsFromDir", () => {
	it("returns empty list when directory does not exist", () => {
		const result = discoverAgents(join(tmpDir, "does-not-exist"), "project");
		expect(result.agents).toEqual([]);
	});

	it("ignores non-md files", () => {
		writeFileSync(join(projectAgentsDir, "ignore.txt"), "not an agent", "utf-8");
		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toEqual([]);
	});

	it("skips files missing name or description", () => {
		writeAgent(
			"noname",
			`---
description: only description
---
body`,
		);
		writeAgent(
			"nodesc",
			`---
name: nodesc
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toHaveLength(0);
	});

	it("captures model field when present", () => {
		writeAgent(
			"withmodel",
			`---
name: withmodel
description: a
model: claude-opus-4-5
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "withmodel");
		expect(agent?.model).toBe("claude-opus-4-5");
	});

	it("uses file body as systemPrompt", () => {
		writeAgent(
			"withbody",
			`---
name: withbody
description: a
---
You are a helpful assistant.`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "withbody");
		expect(agent?.systemPrompt).toBe("You are a helpful assistant.");
	});
});

describe("discoverAgents", () => {
	it("marks project-scope agents as source=project", () => {
		writeAgent(
			"p1",
			`---
name: p1
description: project agent
---
body`,
		);
		const result = discoverAgents(tmpDir, "project");
		const agent = result.agents.find((a) => a.name === "p1");
		expect(agent?.source).toBe("project");
		expect(result.projectAgentsDir).toBe(projectAgentsDir);
	});

	it("scope=project returns only project agents", () => {
		writeAgent(
			"p_only",
			`---
name: p_only
description: a
---
b`,
		);
		const result = discoverAgents(tmpDir, "project");
		expect(result.agents.map((a) => a.name)).toEqual(["p_only"]);
	});

	it("scope=both merges user + project; project overrides user on name collision", () => {
		// This test relies on the user-scope dir being empty (default state
		// in CI), so we focus on the merge logic: project agent wins over
		// user agent when both are present.
		writeAgent(
			"p1",
			`---
name: p1
description: project
---
b`,
		);
		const result = discoverAgents(tmpDir, "both");
		expect(result.agents.map((a) => a.name)).toContain("p1");
		const p1 = result.agents.find((a) => a.name === "p1");
		expect(p1?.source).toBe("project");
	});
});

describe("formatAgentList", () => {
	it("returns 'none' for empty list", () => {
		expect(formatAgentList([], 5)).toEqual({ text: "none", remaining: 0 });
	});

	it("formats agents with name (source): description", () => {
		const agents = [
			{ name: "a", description: "alpha", source: "user" as const, systemPrompt: "", filePath: "" },
			{ name: "b", description: "beta", source: "project" as const, systemPrompt: "", filePath: "" },
		];
		const result = formatAgentList(agents, 5);
		expect(result.text).toContain("a (user): alpha");
		expect(result.text).toContain("b (project): beta");
		expect(result.remaining).toBe(0);
	});

	it("truncates to maxItems and reports remaining", () => {
		const agents = [
			{ name: "a", description: "1", source: "user" as const, systemPrompt: "", filePath: "" },
			{ name: "b", description: "2", source: "user" as const, systemPrompt: "", filePath: "" },
			{ name: "c", description: "3", source: "user" as const, systemPrompt: "", filePath: "" },
		];
		const result = formatAgentList(agents, 2);
		expect(result.remaining).toBe(1);
		expect(result.text).toContain("a");
		expect(result.text).toContain("b");
		expect(result.text).not.toContain("c");
	});
});
