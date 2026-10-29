/**
 * Agent definition files (issue #1046): discovery, frontmatter parsing, and
 * project-over-user precedence. Each test points `ENV_AGENT_DIR` at a fresh
 * temp dir and uses a temp project cwd, so the real ~/.pi is never touched.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { AGENTS_DIR_NAME, agentsDirs, listAgents, parseAgentFile, resolveAgent } from "../src/core/subagent/agents.ts";

function writeAgent(dir: string, file: string, content: string): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, file);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

describe("agent definition files", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	let agentDir: string | undefined;
	let projectDir: string | undefined;
	let cwd: string | undefined;
	let projectAgentsDir: string | undefined;
	let userAgentsDir: string | undefined;
	let warnings: string[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-agents-agent-"));
		projectDir = mkdtempSync(join(tmpdir(), "pi-agents-project-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		cwd = projectDir;
		projectAgentsDir = join(projectDir, CONFIG_DIR_NAME, AGENTS_DIR_NAME);
		userAgentsDir = join(agentDir, AGENTS_DIR_NAME);
		warnings = [];
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of [agentDir, projectDir]) {
			if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		agentDir = undefined;
		projectDir = undefined;
		cwd = undefined;
	});

	it("agentsDirs() reports the project scope first, then the user scope", () => {
		const dirs = agentsDirs(cwd as string);
		expect(dirs.map((entry) => entry.scope)).toEqual(["project", "user"]);
		expect(dirs[0]!.dir).toBe(join(cwd as string, CONFIG_DIR_NAME, AGENTS_DIR_NAME));
		expect(dirs[1]!.dir).toBe(join(agentDir as string, AGENTS_DIR_NAME));
	});

	it("parses the documented frontmatter subset", () => {
		const filePath = writeAgent(
			projectAgentsDir as string,
			"reviewer.md",
			[
				"---",
				"name: reviewer",
				"description: Reviews diffs against the issue.",
				"tools: read, grep, bash",
				"model: anthropic/claude-sonnet-4-5",
				"thinking: high",
				"systemPrompt: You are a terse, precise code reviewer.",
				"---",
				"",
				"Body text that is not the prompt because systemPrompt is set.",
			].join("\n"),
		);
		const definition = parseAgentFile(filePath, "project");
		expect(definition).toBeDefined();
		expect(definition!.name).toBe("reviewer");
		expect(definition!.description).toBe("Reviews diffs against the issue.");
		expect(definition!.tools).toEqual(["read", "grep", "bash"]);
		expect(definition!.model).toBe("anthropic/claude-sonnet-4-5");
		expect(definition!.thinking).toBe("high");
		expect(definition!.systemPrompt).toBe("You are a terse, precise code reviewer.");
		expect(definition!.filePath).toBe(filePath);
		expect(definition!.scope).toBe("project");
	});

	it("accepts `tools` as a YAML sequence and collapses duplicates and blanks", () => {
		const filePath = writeAgent(
			projectAgentsDir as string,
			"scout.md",
			["---", "name: scout", "tools:", "  - read", "  - grep", "  - read", "  -", "---"].join("\n"),
		);
		expect(parseAgentFile(filePath, "project")!.tools).toEqual(["read", "grep"]);
	});

	it("falls back to the markdown body for the system prompt", () => {
		const filePath = writeAgent(
			projectAgentsDir as string,
			"writer.md",
			["---", "name: writer", "---", "", "You rewrite prose in active voice.", "Keep it under 200 words."].join(
				"\n",
			),
		);
		expect(parseAgentFile(filePath, "project")!.systemPrompt).toBe(
			"You rewrite prose in active voice.\nKeep it under 200 words.",
		);
	});

	it("ignores unknown frontmatter keys silently", () => {
		const filePath = writeAgent(
			projectAgentsDir as string,
			"futuristic.md",
			["---", "name: futuristic", "permission_mode: ask", "model: openai/gpt-5", "---"].join("\n"),
		);
		const definition = parseAgentFile(filePath, "project");
		expect(definition!.model).toBe("openai/gpt-5");
		expect((definition as unknown as Record<string, unknown>).permission_mode).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	it("skips a file with no name, with a warning naming the file", () => {
		const filePath = writeAgent(
			projectAgentsDir as string,
			"anonymous.md",
			["---", "description: Has no name key.", "---"].join("\n"),
		);
		expect(parseAgentFile(filePath, "project")).toBeUndefined();
		expect(warnings.join("\n")).toContain("anonymous.md");
		expect(warnings.join("\n")).toContain("name");
	});

	it("skips a file whose thinking level is not in the enum, with a warning", () => {
		const filePath = writeAgent(
			projectAgentsDir as string,
			"bogus.md",
			["---", "name: bogus", "thinking: ultramega", "---"].join("\n"),
		);
		expect(parseAgentFile(filePath, "project")).toBeUndefined();
		expect(warnings.join("\n")).toContain("bogus.md");
		expect(warnings.join("\n")).toContain("ultramega");
	});

	it("rejects a name that looks like a path", () => {
		const filePath = writeAgent(
			projectAgentsDir as string,
			"sneaky.md",
			["---", "name: ../elsewhere", "---"].join("\n"),
		);
		expect(parseAgentFile(filePath, "project")).toBeUndefined();
	});

	it("ignores non-markdown files and subdirectories", () => {
		writeAgent(projectAgentsDir as string, "notes.txt", "---\nname: txt-agent\n---\n");
		writeAgent(join(projectAgentsDir as string, "nested"), "deep.md", "---\nname: deep-agent\n---\n");
		const names = listAgents(cwd as string).map((definition) => definition.name);
		expect(names).toEqual([]);
	});

	it("resolves by name from the project scope", () => {
		writeAgent(projectAgentsDir as string, "reviewer.md", "---\nname: reviewer\nmodel: anthropic/x\n---\n");
		expect(resolveAgent("reviewer", cwd as string)?.filePath).toBe(join(projectAgentsDir as string, "reviewer.md"));
		// The `@name` form the render layer shows is accepted for lookup too.
		expect(resolveAgent("@reviewer", cwd as string)?.name).toBe("reviewer");
		expect(resolveAgent("nope", cwd as string)).toBeUndefined();
	});

	it("project definitions win over user ones on a name collision", () => {
		writeAgent(userAgentsDir as string, "reviewer.md", "---\nname: reviewer\nmodel: user/model\n---\n");
		writeAgent(projectAgentsDir as string, "reviewer.md", "---\nname: reviewer\nmodel: project/model\n---\n");
		const definition = resolveAgent("reviewer", cwd as string);
		expect(definition?.scope).toBe("project");
		expect(definition?.model).toBe("project/model");
		const all = listAgents(cwd as string);
		expect(all.map((entry) => entry.name)).toEqual(["reviewer"]);
	});

	it("lists both scopes, deduped and sorted by name", () => {
		writeAgent(userAgentsDir as string, "zeta.md", "---\nname: zeta\n---\n");
		writeAgent(userAgentsDir as string, "alpha.md", "---\nname: alpha-user\n---\n");
		writeAgent(projectAgentsDir as string, "mid.md", "---\nname: mid\n---\n");
		expect(listAgents(cwd as string).map((definition) => definition.name)).toEqual(["alpha-user", "mid", "zeta"]);
	});

	it("returns an empty list when neither directory exists", () => {
		expect(listAgents(cwd as string)).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("the frontmatter name is the lookup key, not the filename", () => {
		writeAgent(projectAgentsDir as string, "whatever-filename.md", "---\nname: named-elsewhere\n---\n");
		expect(resolveAgent("whatever-filename", cwd as string)).toBeUndefined();
		expect(resolveAgent("named-elsewhere", cwd as string)?.name).toBe("named-elsewhere");
	});
});
