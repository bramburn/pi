/**
 * DAG orchestration: graph validation, level layering, reference substitution,
 * the inline ready-queue scheduler, the `dag-state.json` mirror, abort, cascade
 * skip, and the background branch's registry bookkeeping.
 *
 * The tool is driven through `createSubagentToolDefinition(...).execute(...)`
 * with a stub runner, so these tests exercise the wiring in `execute()` and not
 * only the scheduler in `orchestration.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS, type ResolvedSubagentSettings } from "../src/core/defaults.ts";
import type { BackgroundRegistry, BackgroundTask } from "../src/core/subagent/background.ts";
import {
	capDagNodeOutput,
	computeDagLevels,
	createDagRun,
	DAG_MAX_NODES,
	DAG_NODE_OUTPUT_CAP,
	type DagNodeInput,
	makeDagRunId,
	readDagState,
	runDagInline,
	substituteNodeResults,
	validateDagGraph,
} from "../src/core/subagent/orchestration.ts";
import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";
import type { SubagentResult, SubagentRunner } from "../src/core/subagent/types.ts";
import { createEmptyUsage } from "../src/core/subagent/types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Trace {
	/** Roles in the order their dispatch began. */
	started: string[];
	/** The concrete task text each role received, after `{{nodes.*}}` substitution. */
	tasks: Record<string, string>;
	/** Peak number of concurrently running node dispatches. */
	peakActive: number;
}

interface StubOptions {
	/** Roles whose child fails (non-zero exit). */
	fail?: string[];
	/** Roles whose dispatch throws before the child is created. */
	throwOn?: string[];
	/** Per-dispatch delay, so parallel branches overlap. */
	holdMs?: number;
	/** Output producer, default `out-<role>`. */
	output?: (role: string) => string;
	/** Side effect run when a role's dispatch begins (used to abort mid-run). */
	onStart?: (role: string) => void;
}

function okResult(role: string, task: string, finalOutput: string): SubagentResult {
	return {
		role,
		task,
		exitCode: 0,
		aborted: false,
		finalOutput,
		stderr: "",
		usage: createEmptyUsage(),
		messages: [],
	};
}

function stubRunner(trace: Trace, opts: StubOptions = {}): SubagentRunner {
	let active = 0;
	const fail = new Set(opts.fail ?? []);
	const throwOn = new Set(opts.throwOn ?? []);
	return {
		async run(request): Promise<SubagentResult> {
			const role = request.spec.role;
			if (throwOn.has(role)) throw new Error(`dispatch failed for ${role}`);
			trace.started.push(role);
			trace.tasks[role] = request.task;
			opts.onStart?.(role);
			active += 1;
			trace.peakActive = Math.max(trace.peakActive, active);
			try {
				if (opts.holdMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.holdMs));
				const output = opts.output?.(role) ?? `out-${role}`;
				if (fail.has(role)) {
					return {
						...okResult(role, request.task, output),
						exitCode: 1,
						errorMessage: `${role} exploded`,
					};
				}
				return okResult(role, request.task, output);
			} finally {
				active -= 1;
			}
		},
	};
}

function newTrace(): Trace {
	return { started: [], tasks: {}, peakActive: 0 };
}

interface ToolOptions {
	maxTotalSpawns?: number;
	registry?: BackgroundRegistry;
	onBackgroundSettled?: (id: string, r: SubagentResult) => void;
}

function tool(trace: Trace, opts: StubOptions, extra?: ToolOptions) {
	const settings: ResolvedSubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS };
	if (extra?.maxTotalSpawns !== undefined) settings.maxTotalSpawns = extra.maxTotalSpawns;
	return createSubagentToolDefinition(process.cwd(), {
		runner: stubRunner(trace, opts),
		subagentSettings: () => settings,
		...(extra?.registry === undefined ? {} : { registry: extra.registry }),
		...(extra?.onBackgroundSettled === undefined ? {} : { onBackgroundSettled: extra.onBackgroundSettled }),
	});
}

function execute(
	tool: ReturnType<typeof createSubagentToolDefinition>,
	params: Record<string, unknown>,
	signal?: AbortSignal,
) {
	return tool.execute("tc", params, signal, undefined, undefined as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

/** a → (b, c) → d. b and c are independent, so they overlap. */
const DIAMOND: DagNodeInput[] = [
	{ role: "a", instructions: "start" },
	{ role: "b", instructions: "left {{nodes.a.result}}", dependsOn: ["a"] },
	{ role: "c", instructions: "right {{nodes.a.result}}", dependsOn: ["a"] },
	{ role: "d", instructions: "join {{nodes.b.result}} + {{nodes.c.result}}", dependsOn: ["b", "c"] },
];

const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A dag run mirrors its state to `<agent dir>/subagent-dag/<runId>/`. Point the
// agent dir at a scratch directory so running the suite cannot write into a
// developer's real `~/.pi/agent`.
beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-dag-agent-"));
});
afterAll(() => {
	if (process.env.PI_CODING_AGENT_DIR) rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

// ---------------------------------------------------------------------------

describe("validateDagGraph", () => {
	it("accepts a diamond", () => {
		expect(() => validateDagGraph(DIAMOND)).not.toThrow();
	});

	it("rejects a cycle", () => {
		expect(() =>
			validateDagGraph([
				{ role: "a", instructions: "x", dependsOn: ["b"] },
				{ role: "b", instructions: "y", dependsOn: ["a"] },
			]),
		).toThrow(/cycle/);
	});

	it("rejects duplicate node ids", () => {
		expect(() =>
			validateDagGraph([
				{ role: "a", instructions: "x" },
				{ role: "a", instructions: "y" },
			]),
		).toThrow(/duplicate node id "a"/);
	});

	it("rejects an empty or whitespace-padded node id", () => {
		expect(() => validateDagGraph([{ role: "", instructions: "x" }])).toThrow(/empty `role`/);
		expect(() => validateDagGraph([{ role: " a", instructions: "x" }])).toThrow(/leading or trailing whitespace/);
	});

	it("rejects a dependency on an unknown node", () => {
		expect(() =>
			validateDagGraph([
				{ role: "a", instructions: "x" },
				{ role: "b", instructions: "y", dependsOn: ["nope"] },
			]),
		).toThrow(/depends on unknown node "nope"/);
	});

	it("rejects a self dependency", () => {
		expect(() => validateDagGraph([{ role: "a", instructions: "x", dependsOn: ["a"] }])).toThrow(/depends on itself/);
	});

	it("rejects a {{nodes.X.result}} reference that is not a declared dependency", () => {
		expect(() =>
			validateDagGraph([
				{ role: "a", instructions: "x" },
				{ role: "b", instructions: "y" },
				{ role: "c", instructions: "reads {{nodes.a.result}}", dependsOn: ["b"] },
			]),
		).toThrow(/not one of its `dependsOn` nodes/);
	});

	it("rejects an empty graph", () => {
		expect(() => validateDagGraph([])).toThrow(/at least one node/);
	});
});

describe("computeDagLevels", () => {
	it("layers a diamond as 0,1,1,2", () => {
		expect(computeDagLevels(DIAMOND)).toEqual([0, 1, 1, 2]);
	});

	it("layers a chain by depth, not by array order", () => {
		const nodes: DagNodeInput[] = [
			{ role: "last", instructions: "x", dependsOn: ["mid"] },
			{ role: "mid", instructions: "y", dependsOn: ["first"] },
			{ role: "first", instructions: "z" },
		];
		expect(computeDagLevels(nodes)).toEqual([2, 1, 0]);
	});
});

describe("dag node output substitution", () => {
	it("splices a dependency's real output into the dependent's instructions", () => {
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "use {{nodes.a.result}} now", dependsOn: ["a"] },
		];
		const out = substituteNodeResults(nodes, 1, nodes[1].instructions, ["A-SAID", undefined]);
		expect(out).toBe("use A-SAID now");
	});

	it("caps a reference at DAG_NODE_OUTPUT_CAP and names the truncation", () => {
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "{{nodes.a.result}}", dependsOn: ["a"] },
		];
		const huge = "x".repeat(DAG_NODE_OUTPUT_CAP + 5000);
		const out = substituteNodeResults(nodes, 1, nodes[1].instructions, [huge, undefined]);
		expect(out.length).toBeLessThan(huge.length);
		expect(out).toContain("omitted from this node reference");
		expect(Buffer.byteLength(out.split("\n")[0] ?? "", "utf8")).toBeLessThanOrEqual(DAG_NODE_OUTPUT_CAP);
	});

	it("capDagNodeOutput leaves short output untouched and reports bytes omitted", () => {
		expect(capDagNodeOutput("short", 100)).toBe("short");
		const capped = capDagNodeOutput("abcdefghij", 4);
		expect(capped.startsWith("abcd")).toBe(true);
		expect(capped).toContain("6 bytes omitted");
	});
});

describe("dag mode (inline)", () => {
	it("runs a diamond: dependencies first, independent branches overlapped", async () => {
		const trace = newTrace();
		const result = await execute(tool(trace, { holdMs: 15 }), { dag: DIAMOND });

		expect(result.details?.mode).toBe("dag");
		expect(trace.started[0]).toBe("a");
		expect(trace.started[3]).toBe("d");
		expect(trace.peakActive).toBeGreaterThanOrEqual(2);
		// Substitution really happened: b and d see their dependency's output.
		expect(trace.tasks.b).toBe("left out-a");
		expect(trace.tasks.d).toBe("join out-b + out-c");

		const statuses = Object.fromEntries(result.details?.dag?.nodes.map((n) => [n.name, n.status]) ?? []);
		expect(statuses).toEqual({ a: "completed", b: "completed", c: "completed", d: "completed" });
		expect(result.details?.results).toHaveLength(4);
		expect(textOf(result)).toContain("4/4 completed");
	});

	it("resolves with per-node statuses when a node fails and its dependents skip", async () => {
		const trace = newTrace();
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "y", dependsOn: ["a"] },
			{ role: "c", instructions: "z", dependsOn: ["b"] },
			{ role: "side", instructions: "independent" },
		];
		const result = await execute(tool(trace, { fail: ["b"] }), { dag: nodes });

		const statuses = Object.fromEntries(result.details?.dag?.nodes.map((n) => [n.name, n.status]) ?? []);
		expect(statuses).toEqual({ a: "completed", b: "failed", c: "skipped", side: "completed" });
		expect(result.details?.dag?.status).toBe("failed");
		expect(textOf(result)).toContain("2/4 completed");
		expect(textOf(result)).toContain("1 failed");
		expect(textOf(result)).toContain("1 skipped");
		// The failed node's dependents never spawn.
		expect(trace.started).not.toContain("c");
	});

	it("rejects a bad graph before anything spawns", async () => {
		const trace = newTrace();
		await expect(
			execute(tool(trace, {}), {
				dag: [
					{ role: "a", instructions: "x", dependsOn: ["b"] },
					{ role: "b", instructions: "y", dependsOn: ["a"] },
				],
			}),
		).rejects.toThrow(/dag graph invalid: cycle detected/);
		expect(trace.started).toEqual([]);
	});

	it("counts every node against the session spawn budget, once per node", async () => {
		const trace = newTrace();
		const chain3: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "y", dependsOn: ["a"] },
			{ role: "c", instructions: "z", dependsOn: ["b"] },
		];
		// Cap of 4: the first 3-node graph is admitted, and the same graph a second
		// time is refused whole. `to the current 3` is the assertion that matters —
		// the count is per node, not per settle, per retry, or per level.
		const t = tool(trace, {}, { maxTotalSpawns: 4 });
		const result = await execute(t, { dag: chain3 });
		expect(result.details?.results).toHaveLength(3);
		await expect(execute(t, { dag: chain3 })).rejects.toThrow(/would add 3 spawn\(s\) to the current 3/);
		expect(trace.started).toHaveLength(3);
	});

	it("refuses a graph that would exceed the budget before spawning any node", async () => {
		const trace = newTrace();
		await expect(
			execute(tool(trace, {}, { maxTotalSpawns: 2 }), {
				dag: [
					{ role: "a", instructions: "x" },
					{ role: "b", instructions: "y", dependsOn: ["a"] },
					{ role: "c", instructions: "z", dependsOn: ["b"] },
				],
			}),
		).rejects.toThrow(/spawn budget exceeded/);
		expect(trace.started).toEqual([]);
	});

	it("refuses a graph that exceeds the node cap", async () => {
		const trace = newTrace();
		const nodes: DagNodeInput[] = Array.from({ length: DAG_MAX_NODES + 1 }, (_, i) => ({
			role: `n${i}`,
			instructions: `task ${i}`,
		}));
		await expect(execute(tool(trace, {}), { dag: nodes })).rejects.toThrow(
			new RegExp(`at most ${DAG_MAX_NODES} nodes`),
		);
	});

	it("refuses `agent` combined with a graph", async () => {
		const trace = newTrace();
		await expect(
			execute(tool(trace, {}), {
				agent: "scout",
				dag: [
					{ role: "a", instructions: "x" },
					{ role: "b", instructions: "y", dependsOn: ["a"] },
				],
			}),
		).rejects.toThrow(/mutually exclusive with `role`, `tasks`, `chain`, and `dag`/);
		expect(trace.started).toEqual([]);
	});
});

describe("dag scheduler (runDagInline)", () => {
	it("mirrors every settle to dag-state.json, including failures and skips", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dag-state-"));
		const statePath = join(dir, "subagent-dag", "run-1", "dag-state.json");
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "y", dependsOn: ["a"] },
			{ role: "c", instructions: "z" },
		];
		const run = createDagRun({ nodes, runId: "run-1", statePath });
		const progress = await runDagInline(run, async (launch) => {
			if (launch.node.role === "a") {
				return {
					...okResult("a", launch.instructions, ""),
					exitCode: 1,
					aborted: true,
					errorMessage: "cancelled by user",
				};
			}
			return okResult(launch.node.role, launch.instructions, `out-${launch.node.role}`);
		});

		expect(progress).toMatchObject({ total: 3, settled: 3, running: 0, completed: 1, failed: 1, skipped: 1 });
		const state = readDagState(statePath);
		expect(state?.status).toBe("failed");
		expect(state?.nodes.map((n) => n.status)).toEqual(["failed", "skipped", "completed"]);
		expect(state?.nodes[0]?.error).toBe("cancelled by user");
		// The state file mirrors character counts, never the node's output text.
		expect(state?.nodes[2]?.outputChars).toBe("out-c".length);
		// The run id also has a default location under the agent dir.
		expect(makeDagRunId()).toMatch(/^dag_/);
	});

	it("stops launching new nodes once the signal is aborted and marks pending skipped", async () => {
		const controller = new AbortController();
		const trace = newTrace();
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "y", dependsOn: ["a"] },
			{ role: "c", instructions: "z", dependsOn: ["b"] },
		];
		const run = createDagRun({ nodes, runId: makeDagRunId(), signal: controller.signal });
		const progress = await runDagInline(run, async (launch) => {
			trace.started.push(launch.node.role);
			// Abort while the first node is in flight, then let it settle.
			controller.abort();
			return okResult(launch.node.role, launch.instructions, "out");
		});

		expect(trace.started).toEqual(["a"]);
		expect(progress.failed).toBe(0);
		expect(progress.skipped).toBe(2);
		expect(run.getState().status).toBe("aborted");
		expect(run.getState().nodes.map((n) => n.status)).toEqual(["completed", "skipped", "skipped"]);
	});

	it("fails a node whose dispatch throws and skips its dependents", async () => {
		const trace = newTrace();
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "y", dependsOn: ["a"] },
		];
		const run = createDagRun({ nodes, runId: makeDagRunId() });
		await runDagInline(run, async (launch) => {
			trace.started.push(launch.node.role);
			if (launch.node.role === "a") throw new Error("spawn refused");
			return okResult(launch.node.role, launch.instructions, "out");
		});
		expect(run.getState().nodes[0]?.error).toContain("spawn refused");
		expect(run.getState().nodes[1]?.status).toBe("skipped");
		expect(trace.started).toEqual(["a"]);
	});
});

describe("dag mode (background)", () => {
	function fakeRegistry(ids: string[]): BackgroundRegistry {
		let seq = 0;
		return {
			makeTaskId: () => {
				const id = `bg_test_${seq++}`;
				ids.push(id);
				return id;
			},
			add(_task: BackgroundTask) {},
			update() {},
			appendLog() {},
			listRunning: () => [],
			snapshot: () => ({ tasks: [] }),
			markAllRunningAsCrashed: async () => 0,
			prune: async () => 0,
			cancel: async () => ({ kind: "cancelled-queued" }) as const,
		};
	}

	it("reports one id per node and settles every dispatched node", async () => {
		const ids: string[] = [];
		const settled: Array<{ id: string; role: string }> = [];
		const trace = newTrace();
		const result = await execute(
			tool(
				trace,
				{ holdMs: 5 },
				{
					registry: fakeRegistry(ids),
					onBackgroundSettled: (id, r) => settled.push({ id, role: r.role }),
				},
			),
			{ background: true, dag: DIAMOND },
		);

		expect(result.details?.mode).toBe("dag");
		expect(result.details?.taskIds).toHaveLength(4);
		expect(textOf(result)).toContain("Started 4 background tasks:");
		expect(textOf(result)).toContain("(dag)");

		await settle(120);
		// Every node settled exactly once, keyed by its registry id.
		expect(settled.map((s) => s.role).sort()).toEqual(["a", "b", "c", "d"]);
		expect(new Set(settled.map((s) => s.id)).size).toBe(4);
		expect(result.details?.taskIds).toEqual(expect.arrayContaining(settled.map((s) => s.id)));
	});

	it("closes the registry row of a node that never dispatches (cascade skip)", async () => {
		const updates: Array<{ id: string; status?: string }> = [];
		const ids: string[] = [];
		const settled: string[] = [];
		const registry: BackgroundRegistry = {
			makeTaskId: () => `bg_skip_${ids.length}`,
			add() {},
			update(taskId, partial) {
				updates.push({ id: taskId, status: partial.status });
			},
			appendLog() {},
			listRunning: () => [],
			snapshot: () => ({ tasks: [] }),
			markAllRunningAsCrashed: async () => 0,
			prune: async () => 0,
			cancel: async () => ({ kind: "cancelled-queued" }) as const,
		};
		const trace = newTrace();
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "y", dependsOn: ["a"] },
			{ role: "c", instructions: "z", dependsOn: ["b"] },
		];
		const result = await execute(
			tool(
				trace,
				{ fail: ["b"], holdMs: 5 },
				{
					registry,
					onBackgroundSettled: (id) => settled.push(id),
				},
			),
			{ background: true, dag: nodes },
		);

		expect(result.details?.taskIds).toHaveLength(3);
		await settle(120);
		// The skipped node was never dispatched, yet its promised id is settled
		// and its row is closed rather than left running forever.
		expect(trace.started).toEqual(["a", "b"]);
		expect(settled).toHaveLength(3);
		expect(updates.some((u) => u.status === "failed")).toBe(true);
	});

	it("treats a dispatch that throws as a node failure and skips dependents", async () => {
		const settled: Array<{ role: string; error?: string }> = [];
		const trace = newTrace();
		const nodes: DagNodeInput[] = [
			{ role: "a", instructions: "x" },
			{ role: "b", instructions: "y", dependsOn: ["a"] },
		];
		const result = await execute(
			tool(
				trace,
				{ throwOn: ["a"] },
				{
					onBackgroundSettled: (_id, r) => settled.push({ role: r.role, error: r.errorMessage }),
				},
			),
			{ background: true, dag: nodes },
		);

		expect(result.details?.taskIds).toHaveLength(2);
		await settle(60);
		expect(settled.map((s) => s.role)).toEqual(["a", "b"]);
		expect(settled[0]?.error).toContain("dispatch failed for a");
		expect(settled[1]?.error).toContain('Skipped: dependency "a" failed');
	});
});
