import { describe, expect, it } from "vitest";
import { type BackgroundRegistry, type BackgroundTask, RegistryLockError } from "../src/core/subagent/background.ts";
import {
	createSubagentToolDefinition,
	PER_TASK_OUTPUT_CAP,
	resolveModelOverrides,
} from "../src/core/subagent/subagent-tool.ts";
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
	it("throws an error naming the model and dispatches nothing", async () => {
		const capture = { models: [] as string[] };
		const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner(capture), resolveModel });
		await expect(
			tool.execute(
				"tc1",
				{ role: "scout", instructions: "x", model: "nope-9" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow('Unknown model "nope-9"');
		expect(capture.models).toEqual([]);
	});

	it("passes the canonical model to the runner", async () => {
		const capture = { models: [] as string[] };
		const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner(capture), resolveModel });
		await tool.execute(
			"tc2",
			{ role: "scout", instructions: "x", model: "cheap-1" },
			undefined,
			undefined,
			undefined as never,
		);
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

	it("rejects zero modes and multiple modes by throwing", async () => {
		const tool = createSubagentToolDefinition(process.cwd(), { runner: okRunner });
		await expect(tool.execute("t1", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			"exactly one mode",
		);

		await expect(
			tool.execute(
				"t2",
				{ role: "a", instructions: "x", tasks: [{ role: "b", instructions: "y" }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("exactly one mode");
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

	it("chain stops at the first failure and throws naming the step", async () => {
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
		await expect(
			tool.execute(
				"t4",
				{
					chain: [
						{ role: "s1", instructions: "a" },
						{ role: "s2", instructions: "b" },
					],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Chain stopped at step 1 (s1)");
		expect(ran).toEqual(["s1"]);
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

	it("parallel partial failure resolves with both per-task summaries", async () => {
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
			{
				tasks: [
					{ role: "good", instructions: "1" },
					{ role: "bad", instructions: "2" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result).not.toHaveProperty("isError");
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Parallel: 1/2 succeeded");
		expect(text).toContain("[good] completed");
		expect(text).toContain("[bad] failed");
	});

	it("chain {previous} substitution keeps $ patterns verbatim", async () => {
		const seen: string[] = [];
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				seen.push(request.task);
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 0,
					aborted: false,
					finalOutput: request.spec.role === "s1" ? "A $& B $` C $' D $$ E" : "ok",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		const result = await tool.execute(
			"t7",
			{
				chain: [
					{ role: "s1", instructions: "produce" },
					{ role: "s2", instructions: "review {previous} !" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(seen[1]).toBe("review A $& B $` C $' D $$ E !");
		expect((result.content[0] as { text: string }).text).toBe("ok");
	});

	it("caps single-mode output at 50 KB and keeps the full output in details", async () => {
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
			"t8",
			{ role: "big", instructions: "go" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Output truncated:");
		expect(text.length).toBeLessThan(52_000);
		expect((result.details as { results: { finalOutput: string }[] }).results[0].finalOutput).toBe(bigText);
	});

	it("caps the {previous} substitution input at 50 KB", async () => {
		const bigText = "x".repeat(60 * 1024);
		const seen: string[] = [];
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				seen.push(request.task);
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
		await tool.execute(
			"t9",
			{
				chain: [
					{ role: "s1", instructions: "produce" },
					{ role: "s2", instructions: "review {previous}" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(seen[1]).toContain("Output truncated:");
		expect(seen[1].length).toBeLessThan(52_000);
	});

	it("truncation never splits a UTF-16 surrogate pair", async () => {
		const emoji = "\u{1F600}";
		const output = "x".repeat(PER_TASK_OUTPUT_CAP - 3) + emoji + "y".repeat(100);
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 0,
					aborted: false,
					finalOutput: output,
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		const result = await tool.execute(
			"t10",
			{ role: "emoji", instructions: "go" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		const body = text.slice(0, text.indexOf("\n\n[Output truncated:"));
		// Byte cap lands inside the emoji; the kept body must end before it, never
		// on a lone surrogate half.
		expect(body).toBe("x".repeat(PER_TASK_OUTPUT_CAP - 3));
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(PER_TASK_OUTPUT_CAP);
	});
});

describe("failure-throw output cap", () => {
	it("caps embedded output in a thrown single-failure error at 50 KB", async () => {
		const bigText = "x".repeat(60 * 1024);
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 1,
					aborted: false,
					finalOutput: "",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
					errorMessage: bigText,
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		let message = "";
		try {
			await tool.execute("t13", { role: "bad", instructions: "go" }, undefined, undefined, undefined as never);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message.startsWith("Subagent bad failed: ")).toBe(true);
		expect(message).toContain("Output truncated:");
		expect(message.length).toBeLessThan(52_000);
	});

	it("caps embedded output in a thrown chain-failure error at 50 KB", async () => {
		const bigText = "x".repeat(60 * 1024);
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 1,
					aborted: false,
					finalOutput: "",
					stderr: bigText,
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		let message = "";
		try {
			await tool.execute(
				"t14",
				{
					chain: [
						{ role: "s1", instructions: "a" },
						{ role: "s2", instructions: "b" },
					],
				},
				undefined,
				undefined,
				undefined as never,
			);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message.startsWith("Chain stopped at step 1 (s1): ")).toBe(true);
		expect(message).toContain("Output truncated:");
		expect(message.length).toBeLessThan(52_000);
	});
});

describe("single-mode failure throw (Node pin)", () => {
	it("rejects with the Subagent <role> failed: shape", async () => {
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 2,
					aborted: false,
					finalOutput: "",
					stderr: "boom",
					usage: createEmptyUsage(),
					messages: [],
					errorMessage: "boom",
				};
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		await expect(
			tool.execute("t15", { role: "scout", instructions: "go" }, undefined, undefined, undefined as never),
		).rejects.toThrow("Subagent scout failed: boom");
	});
});

describe("parallel progress counting", () => {
	it("counts a failed spawn as done, not running", async () => {
		const texts: string[] = [];
		const runner: SubagentRunner = {
			async run(): Promise<SubagentResult> {
				throw new Error("spawn failed");
			},
		};
		const tool = createSubagentToolDefinition(process.cwd(), { runner });
		const result = await tool.execute(
			"t16",
			{ tasks: [{ role: "dead", instructions: "go" }] },
			undefined,
			(update) => {
				texts.push((update.content[0] as { text: string }).text);
			},
			undefined as never,
		);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts[texts.length - 1]).toBe("Parallel: 1/1 done, 0 running...");
		expect((result.content[0] as { text: string }).text).toContain("Parallel: 0/1 succeeded");
	});
});

describe("background chain continuation guard", () => {
	it("settles a step whose dispatch throws instead of dropping it", async () => {
		const updates: Array<{ taskId: string; partial: Partial<BackgroundTask> }> = [];
		const settled: Array<{ taskId: string; result: SubagentResult }> = [];
		const registry: BackgroundRegistry = {
			makeTaskId: () => `bg_test_${Math.random().toString(36).slice(2)}`,
			add(task) {
				// Simulate RegistryLockError on the second dispatch.
				if (task.role === "s2") throw new RegistryLockError("/fake/registry.lock");
			},
			update(taskId, partial) {
				updates.push({ taskId, partial });
			},
			appendLog() {},
			listRunning: () => [],
			snapshot: () => ({ tasks: [] }),
			markAllRunningAsCrashed: async () => 0,
			prune: async () => 0,
			cancel: async () => ({ kind: "cancelled-queued" }),
		};
		const runner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
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
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner,
			registry,
			onBackgroundSettled: (taskId, result) => {
				settled.push({ taskId, result });
			},
		});
		const result = await tool.execute(
			"t17",
			{
				background: true,
				chain: [
					{ role: "s1", instructions: "a" },
					{ role: "s2", instructions: "b {previous}" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect((result.content[0] as { text: string }).text).toContain("Started 2 background tasks");
		// The continuation runs detached once s1 settles (microtasks + one tick).
		await new Promise<void>((resolve) => {
			setTimeout(() => resolve(), 25);
		});
		expect(settled).toHaveLength(2);
		expect(settled[0]?.result.finalOutput).toBe("ok");
		expect(settled[1]?.result.role).toBe("s2");
		expect(settled[1]?.result.errorMessage).toContain("could not be dispatched");
		expect(updates.some((u) => u.partial.status === "failed")).toBe(true);
	});
});
