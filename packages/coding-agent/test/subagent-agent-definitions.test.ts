/**
 * Agent definition files (issue #1046) seen from the `agent` dispatch field:
 * a markdown file under `.pi/agents/<name>.md` (project scope) or the user-level
 * agent dir names a reusable agent, and the tool expands it into the inline
 * dispatch fields before mode validation. Saved specs stay the fallback.
 *
 * Every test points ENV_AGENT_DIR at a temp dir, so the real ~/.pi/agent is
 * never read or written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { THINKING_LEVEL_OPTIONS } from "../src/core/defaults.ts";
import { saveSpec } from "../src/core/subagent/saved-specs.ts";
import { createSubagentToolDefinition, subagentSchema } from "../src/core/subagent/subagent-tool.ts";
import type { SubagentResult, SubagentRunner, SubagentRunRequest } from "../src/core/subagent/types.ts";
import { createEmptyUsage } from "../src/core/subagent/types.ts";

let agentDir: string;
let projectDir: string;
const previousAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-def-agents-"));
	projectDir = mkdtempSync(join(tmpdir(), "pi-def-project-"));
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

function writeDefinition(scope: "project" | "user", content: string): void {
	const dir = scope === "project" ? join(projectDir, ".pi", "agents") : join(agentDir, "agents");
	mkdirSync(dir, { recursive: true });
	// File name is irrelevant: the frontmatter `name` is what discovery reads.
	writeFileSync(join(dir, "definition.md"), content, "utf-8");
}

/** Runner that records each request and settles it successfully. */
function captureRunner(capture: { requests: SubagentRunRequest[] }): SubagentRunner {
	return {
		async run(request): Promise<SubagentResult> {
			capture.requests.push(request);
			return {
				role: request.spec.role,
				task: request.task,
				exitCode: 0,
				aborted: false,
				finalOutput: "done",
				stderr: "",
				usage: createEmptyUsage(),
				messages: [],
			};
		},
	};
}

function makeTool(capture: { requests: SubagentRunRequest[] }) {
	return createSubagentToolDefinition(projectDir, { runner: captureRunner(capture) });
}

async function dispatch(capture: { requests: SubagentRunRequest[] }, params: Record<string, unknown>, id = "tc") {
	return makeTool(capture).execute(id, params as never, undefined, undefined, undefined as never);
}

describe("agent definition dispatch", () => {
	it("takes role, tools, and model from the file and the task from instructions", async () => {
		writeDefinition(
			"project",
			"---\nname: reviewer\ndescription: Reviews code.\ntools: read, grep\nmodel: opus\n---\n",
		);
		const capture = { requests: [] as SubagentRunRequest[] };
		await dispatch(capture, { agent: "reviewer", instructions: "Review src/foo.ts" });
		expect(capture.requests).toHaveLength(1);
		const spec = capture.requests[0].spec;
		expect(spec.role).toBe("reviewer");
		expect(spec.instructions).toBe("Review src/foo.ts");
		expect(spec.tools).toEqual(["read", "grep"]);
		expect(spec.model).toBe("opus");
	});

	it("prepends the markdown body to the call's task", async () => {
		writeDefinition(
			"project",
			"---\nname: scout\ndescription: Maps code.\ntools: read, bash\n---\n\nYou are a scout. Map the repo, then report.\n",
		);
		const capture = { requests: [] as SubagentRunRequest[] };
		await dispatch(capture, { agent: "@scout", instructions: "Find the auth entry points" });
		expect(capture.requests).toHaveLength(1);
		const spec = capture.requests[0].spec;
		// The model may type the '@' prefix; the definition name is the bare label.
		expect(spec.role).toBe("scout");
		expect(spec.instructions).toBe("You are a scout. Map the repo, then report.\n\nFind the auth entry points");
	});

	it("prefers the project definition over a user definition with the same name", async () => {
		writeDefinition("user", "---\nname: worker\ndescription: User scope.\ntools: read\n---\nuser prompt\n");
		writeDefinition(
			"project",
			"---\nname: worker\ndescription: Project scope.\ntools: read, bash\n---\nproject prompt\n",
		);
		const capture = { requests: [] as SubagentRunRequest[] };
		await dispatch(capture, { agent: "worker", instructions: "task" });
		const spec = capture.requests[0].spec;
		expect(spec.tools).toEqual(["read", "bash"]);
		expect(spec.instructions).toBe("project prompt\n\ntask");
	});

	it("applies the file's thinking level, and an inline thinking override wins", async () => {
		writeDefinition("project", "---\nname: planner\ndescription: Plans.\nthinking: high\n---\n");
		const capture = { requests: [] as SubagentRunRequest[] };
		await dispatch(capture, { agent: "planner", instructions: "plan" }, "tc1");
		await dispatch(capture, { agent: "planner", instructions: "plan", thinking: "low" }, "tc2");
		expect(capture.requests.map((request) => request.spec.thinking)).toEqual(["high", "low"]);
	});

	it("lets the call override the file's model and tools", async () => {
		writeDefinition(
			"project",
			"---\nname: worker\ndescription: Works.\ntools: read\nmodel: sonnet\nthinking: low\n---\n",
		);
		const capture = { requests: [] as SubagentRunRequest[] };
		await dispatch(capture, { agent: "worker", instructions: "task", model: "opus", tools: ["read", "bash"] });
		const spec = capture.requests[0].spec;
		expect(spec.model).toBe("opus");
		expect(spec.tools).toEqual(["read", "bash"]);
		// thinking was not overridden, so the file's value still applies.
		expect(spec.thinking).toBe("low");
	});

	it("rejects a definition dispatched with no task", async () => {
		writeDefinition("project", "---\nname: reviewer\ndescription: Reviews code.\n---\n");
		const capture = { requests: [] as SubagentRunRequest[] };
		await expect(dispatch(capture, { agent: "reviewer" })).rejects.toThrow(/must come from `instructions`/);
		expect(capture.requests).toEqual([]);
	});

	it("rejects agent with role before resolving the name, dispatching nothing", async () => {
		const capture = { requests: [] as SubagentRunRequest[] };
		await expect(dispatch(capture, { agent: "reviewer", role: "other", instructions: "task" })).rejects.toThrow(
			/mutually exclusive/,
		);
		expect(capture.requests).toEqual([]);
	});

	it("rejects agent with tasks and with chain", async () => {
		const capture = { requests: [] as SubagentRunRequest[] };
		await expect(dispatch(capture, { agent: "reviewer", tasks: [{ role: "a", instructions: "x" }] })).rejects.toThrow(
			/mutually exclusive/,
		);
		await expect(dispatch(capture, { agent: "reviewer", chain: [{ role: "a", instructions: "x" }] })).rejects.toThrow(
			/mutually exclusive/,
		);
		expect(capture.requests).toEqual([]);
	});

	it("names discovered definitions and saved specs when the agent is unknown", async () => {
		writeDefinition("project", "---\nname: known-proj\ndescription: A project definition.\n---\n");
		writeDefinition("user", "---\nname: known-user\ndescription: A user definition.\n---\n");
		saveSpec("known-spec", { role: "s", instructions: "i" });
		const capture = { requests: [] as SubagentRunRequest[] };
		let message = "";
		try {
			await dispatch(capture, { agent: "typo", instructions: "task" });
			expect.unreachable("unknown agent should throw");
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("typo");
		expect(message).toContain("known-proj");
		expect(message).toContain("known-user");
		expect(message).toContain("known-spec");
		expect(message).toContain(join(".pi", "agents"));
		expect(capture.requests).toEqual([]);
	});

	it("skips an invalid definition file and still dispatches the valid one", async () => {
		writeDefinition("project", "---\ndescription: Missing a name.\ntools: read\n---\n");
		writeDefinition("project", "---\nname: valid\ndescription: Valid.\n---\n");
		const capture = { requests: [] as SubagentRunRequest[] };
		await dispatch(capture, { agent: "valid", instructions: "task" });
		expect(capture.requests).toHaveLength(1);
	});

	it("still dispatches a saved spec, and still rejects per-call instructions for it", async () => {
		saveSpec("tight", { role: "tight role", instructions: "tight task", tools: ["read"], thinking: "medium" });
		const capture = { requests: [] as SubagentRunRequest[] };
		await dispatch(capture, { agent: "tight" });
		expect(capture.requests[0].spec).toMatchObject({
			role: "tight role",
			instructions: "tight task",
			tools: ["read"],
			thinking: "medium",
		});
		await expect(dispatch(capture, { agent: "tight", instructions: "override" }, "tc2")).rejects.toThrow(
			/saved spec/,
		);
	});

	it("reports definitions through the same listing an unknown name suggests, not through list-specs", async () => {
		writeDefinition("project", "---\nname: docs\ndescription: Docs agent.\n---\n");
		const capture = { requests: [] as SubagentRunRequest[] };
		const result = (await dispatch(capture, { action: "list-specs" })) as unknown as { content: { text: string }[] };
		expect(result.content[0].text).toContain("Saved subagent specs: 0");
		expect(capture.requests).toEqual([]);
	});
});

describe("subagent tool thinking schema", () => {
	it("offers exactly the shared thinking levels", () => {
		const thinking = (subagentSchema as unknown as { properties: { thinking: { anyOf?: { const?: string }[] } } })
			.properties.thinking;
		expect((thinking.anyOf ?? []).map((entry) => entry.const)).toEqual([...THINKING_LEVEL_OPTIONS]);
	});
});
