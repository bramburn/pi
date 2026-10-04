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

describe("subagent dispatch modes", () => {
	const okRunner: SubagentRunner = {
		async run(request, _signal, onEvent): Promise<SubagentResult> {
			onEvent?.({ type: "spawned", pid: 4242 });
			return {
				role: request.spec.role,
				task: request.task,
				exitCode: 0,
				aborted: false,
				finalOutput: `out:${request.spec.role}`,
				stderr: "",
				usage: createEmptyUsage(),
				messages: [],
				...(request.step === undefined ? {} : { step: request.step }),
			};
		},
	};

	it("rejects zero modes and multiple modes as tool errors", async () => {
		const tool = createSubagentToolDefinition(process.cwd(), { runner: okRunner });
		const none = await tool.execute("t1", {}, undefined, undefined, undefined as never);
		expect((none as { isError?: boolean }).isError).toBe(true);
		expect((none.content[0] as { text: string }).text).toContain("exactly one mode");

		const two = await tool.execute(
			"t2",
			{ role: "a", instructions: "x", tasks: [{ role: "b", instructions: "y" }] },
			undefined,
			undefined,
			undefined as never,
		);
		expect((two as { isError?: boolean }).isError).toBe(true);
	});

	it("chain substitutes {previous} at every occurrence and numbers steps", async () => {
		const seen: string[] = [];
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				seen.push(`step${request.step}:${request.task}`);
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 0,
					aborted: false,
					finalOutput: `PREV-${request.spec.role}`,
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
					...(request.step === undefined ? {} : { step: request.step }),
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		const result = await tool.execute(
			"t3",
			{
				chain: [
					{ role: "s1", instructions: "produce" },
					{ role: "s2", instructions: "review {previous} and {previous}" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(seen).toEqual(["step1:produce", "step2:review PREV-s1 and PREV-s1"]);
		expect((result.content[0] as { text: string }).text).toBe("PREV-s2");
		const steps = (result.details as { results: { step?: number }[] }).results.map((r) => r.step);
		expect(steps).toEqual([1, 2]);
	});

	it("chain stops at the first failure and names the step", async () => {
		const ran: string[] = [];
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				ran.push(request.spec.role);
				const failed = request.spec.role === "s1";
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: failed ? 2 : 0,
					aborted: false,
					finalOutput: "",
					stderr: "boom",
					usage: createEmptyUsage(),
					messages: [],
					...(failed ? { errorMessage: "boom" } : {}),
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		const result = await tool.execute(
			"t4",
			{ chain: [{ role: "s1", instructions: "a" }, { role: "s2", instructions: "b" }] },
			undefined,
			undefined,
			undefined as never,
		);
		expect(ran).toEqual(["s1"]);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("Chain stopped at step 1 (s1)");
	});

	it("caps parallel output at 50 KB in text and keeps the full output in details", async () => {
		const bigText = "x".repeat(60 * 1024);
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 0,
					aborted: false,
					finalOutput: bigText,
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		const result = await tool.execute(
			"t5",
			{ tasks: [{ role: "big", instructions: "go" }] },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Output truncated:");
		expect(text.length).toBeLessThan(52_000);
		expect((result.details as { results: { finalOutput: string }[] }).results[0].finalOutput).toBe(bigText);
	});

	it("parallel partial failure marks the call as an error with both summaries", async () => {
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				const failed = request.spec.role === "bad";
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: failed ? 3 : 0,
					aborted: false,
					finalOutput: failed ? "" : "done",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
					...(failed ? { errorMessage: "kaboom" } : {}),
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		const result = await tool.execute(
			"t6",
			{ tasks: [{ role: "good", instructions: "1" }, { role: "bad", instructions: "2" }] },
			undefined,
			undefined,
			undefined as never,
		);
		expect((result as { isError?: boolean }).isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Parallel: 1/2 succeeded");
		expect(text).toContain("[good] completed");
		expect(text).toContain("[bad] failed");
	});
});
