import { describe, expect, it } from "vitest";
import { createSubagentToolDefinition, resolveModelOverrides } from "../src/core/subagent/subagent-tool.ts";
import type { SubagentResult, SubagentRunner } from "../src/core/subagent/types.ts";
import { createEmptyUsage } from "../src/core/subagent/types.ts";
import { buildSystemPrompt, SUBAGENT_USAGE } from "../src/core/system-prompt.ts";

function stubRunner(capture: { models: string[] }): SubagentRunner {
	return {
		async run(request): Promise<SubagentResult> {
			capture.models.push(request.spec.model ?? "(inherited)");
			return {
				role: request.spec.role,
				task: request.task,
				exitCode: 0,
				aborted: false,
				finalOutput: "ok",
				stderr: "",
				usage: createEmptyUsage(),
				messages: [],
			};
		},
	};
}

const known: Record<string, string> = {
	"cheap-1": "prov/cheap-1.0",
	"strong-2": "prov/strong-2.0",
};
const resolveModel = (id: string): string | undefined => known[id];

describe("resolveModelOverrides", () => {
	it("canonicalizes models in single, tasks, and chain positions", () => {
		const { input, error } = resolveModelOverrides(
			{
				role: "a",
				instructions: "x",
				model: "cheap-1",
				tasks: [{ role: "b", instructions: "y", model: "strong-2" }],
				chain: [{ role: "c", instructions: "z", model: "cheap-1" }],
			},
			resolveModel,
		);
		expect(error).toBeUndefined();
		expect(input.model).toBe("prov/cheap-1.0");
		expect(input.tasks?.[0].model).toBe("prov/strong-2.0");
		expect(input.chain?.[0].model).toBe("prov/cheap-1.0");
	});

	it("returns an error naming the unknown model and its role", () => {
		const original = { tasks: [{ role: "scout", instructions: "y", model: "nope-9" }] };
		const { input, error } = resolveModelOverrides(original, resolveModel);
		expect(error).toContain('Unknown model "nope-9"');
		expect(error).toContain('subagent "scout"');
		expect(input).toBe(original);
	});

	it("never calls the resolver for specs without a model override", () => {
		let calls = 0;
		const { input, error } = resolveModelOverrides({ role: "a", instructions: "x" }, (id) => {
			calls += 1;
			return id;
		});
		expect(error).toBeUndefined();
		expect(input).toEqual({ role: "a", instructions: "x" });
		expect(calls).toBe(0);
	});
});

describe("subagent tool model validation", () => {
	it("returns a tool error naming the model instead of throwing", async () => {
		const capture = { models: [] as string[] };
		const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner(capture), resolveModel });
		const result = await tool.execute("tc1", { role: "scout", instructions: "x", model: "nope-9" }, undefined, undefined, undefined as never);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain('Unknown model "nope-9"');
		expect(capture.models).toEqual([]);
	});

	it("passes the canonical model to the runner", async () => {
		const capture = { models: [] as string[] };
		const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner(capture), resolveModel });
		await tool.execute("tc2", { role: "scout", instructions: "x", model: "cheap-1" }, undefined, undefined, undefined as never);
		expect(capture.models).toEqual(["prov/cheap-1.0"]);
	});
});

describe("SUBAGENT_USAGE", () => {
	const base = { cwd: "/tmp/project", toolSnippets: { read: "r", bash: "b" } };

	it("renders only when the subagent tool is active", () => {
		const withTool = buildSystemPrompt({ ...base, selectedTools: ["read", "bash", "subagent"] });
		const withoutTool = buildSystemPrompt({ ...base, selectedTools: ["read", "bash"] });
		expect(withTool).toContain(SUBAGENT_USAGE);
		expect(withTool).toContain("Subagent delegation");
		expect(withoutTool).not.toContain(SUBAGENT_USAGE);
		expect(withoutTool).not.toContain("Subagent delegation");
	});

	it("keeps the surrounding prompt intact when absent", () => {
		const withoutTool = buildSystemPrompt({ ...base, selectedTools: ["read", "bash"] });
		expect(withoutTool).not.toContain("\n\n\n");
		const withTool = buildSystemPrompt({ ...base, selectedTools: ["read", "bash", "subagent"] });
		expect(withTool).not.toContain("\n\n\n");
	});

	it("teaches the orchestration contract", () => {
		expect(SUBAGENT_USAGE).toContain("fresh context");
		expect(SUBAGENT_USAGE).toContain("tasks: [...]");
		expect(SUBAGENT_USAGE).toContain("chain: [...]");
		expect(SUBAGENT_USAGE).toContain("{previous}");
		expect(SUBAGENT_USAGE).toContain("model");
	});
});
