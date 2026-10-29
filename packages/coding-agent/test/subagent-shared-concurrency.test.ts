import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS, type ResolvedSubagentSettings } from "../src/core/defaults.ts";
import { _resetBackgroundRegistryForTests, getBackgroundRegistry } from "../src/core/subagent/background.ts";
import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";
import {
	createEmptyUsage,
	type SubagentRunner,
	type InFlightRun as SubagentRunningInfo,
	type SubagentRunRequest,
} from "../src/core/subagent/types.ts";

interface ControlledChild {
	request: SubagentRunRequest;
	resolve: (output?: string) => void;
}

function createControlledRunner() {
	const active = new Map<string, SubagentRunningInfo>();
	const pending: ControlledChild[] = [];
	let maxObservedConcurrent = 0;
	let seq = 0;

	const runner: SubagentRunner = {
		listRunning: () => Array.from(active.values()),
		run: (request) => {
			const runId = `run-${++seq}`;
			active.set(runId, {
				runId,
				role: request.spec.role,
				task: request.task,
				cwd: request.cwd,
				startedAt: new Date().toISOString(),
			});
			if (active.size > maxObservedConcurrent) {
				maxObservedConcurrent = active.size;
			}
			return new Promise((resolve) => {
				pending.push({
					request,
					resolve: (output = `ok:${request.spec.role}`) => {
						active.delete(runId);
						resolve({
							role: request.spec.role,
							task: request.task,
							exitCode: 0,
							aborted: false,
							finalOutput: output,
							stderr: "",
							usage: createEmptyUsage(),
							messages: [],
						});
					},
				});
			});
		},
	};

	return {
		runner,
		pending,
		getActiveCount: () => active.size,
		getMaxObservedConcurrent: () => maxObservedConcurrent,
	};
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe("REQ-C02 & REQ-C03: shared session-scoped subagent concurrency budget", () => {
	let tempDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `subagent-shared-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		prevAgentDir = process.env.QI_CODING_AGENT_DIR;
		process.env.QI_CODING_AGENT_DIR = tempDir;
		_resetBackgroundRegistryForTests();
	});

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		if (prevAgentDir === undefined) delete process.env.QI_CODING_AGENT_DIR;
		else process.env.QI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("parks background dispatch when 4 inline children are running and promotes when one settles", async () => {
		const h = createControlledRunner();
		const registry = getBackgroundRegistry();
		const settings: ResolvedSubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS, maxConcurrent: 4 };
		const tool = createSubagentToolDefinition(tempDir, {
			runner: h.runner,
			registry,
			subagentSettings: () => settings,
		});

		const inlineCall = tool.execute(
			"c1",
			{
				// Read-only tool sets keep the batch concurrent-safe (REQ-C01): an
				// omitted `tools` inherits bash/edit/write and would serialise to 1.
				tasks: [
					{ role: "t1", instructions: "work 1", tools: ["read", "grep"] },
					{ role: "t2", instructions: "work 2", tools: ["read", "grep"] },
					{ role: "t3", instructions: "work 3", tools: ["read", "grep"] },
					{ role: "t4", instructions: "work 4", tools: ["read", "grep"] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);

		await tick();
		expect(h.getActiveCount()).toBe(4);

		const bgRes = await tool.execute(
			"c2",
			// REQ-P02: a detached child needs explicit admission — narrowed read-only
			// tools here (no `allowDetachedShell`).
			{ role: "bg1", instructions: "bg work", background: true, tools: ["read"] },
			undefined,
			undefined,
			{} as never,
		);
		const bgId = bgRes.details?.taskIds?.[0] as string;
		expect(bgId).toBeDefined();
		expect(h.getActiveCount()).toBe(4);
		expect(registry.snapshot().tasks.find((t) => t.id === bgId)?.status).toBe("pending");

		// Settle one inline child -> queued background task must promote and spawn
		h.pending.shift()?.resolve();
		await tick();
		expect(h.getActiveCount()).toBe(4);
		expect(h.pending.some((p) => p.request.spec.role === "bg1")).toBe(true);

		while (h.pending.length > 0) {
			h.pending.shift()?.resolve();
			await tick();
		}
		await inlineCall;
		expect(h.getMaxObservedConcurrent()).toBeLessThanOrEqual(4);
	});

	it("enforces maxConcurrent across concurrent parallel, single, and chain tool invocations in one session", async () => {
		const h = createControlledRunner();
		const registry = getBackgroundRegistry();
		const settings: ResolvedSubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS, maxConcurrent: 4 };
		const tool = createSubagentToolDefinition(tempDir, {
			runner: h.runner,
			registry,
			subagentSettings: () => settings,
		});

		const p1 = tool.execute(
			"call-p1",
			{
				tasks: [
					{ role: "a1", instructions: "1" },
					{ role: "a2", instructions: "2" },
					{ role: "a3", instructions: "3" },
					{ role: "a4", instructions: "4" },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		const p2 = tool.execute(
			"call-p2",
			{
				tasks: [
					{ role: "b1", instructions: "1" },
					{ role: "b2", instructions: "2" },
					{ role: "b3", instructions: "3" },
					{ role: "b4", instructions: "4" },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		const singleCall = tool.execute(
			"call-s1",
			{ role: "s1", instructions: "single" },
			undefined,
			undefined,
			{} as never,
		);
		const chainCall = tool.execute(
			"call-ch1",
			{
				chain: [
					{ role: "c1", instructions: "step 1" },
					{ role: "c2", instructions: "step 2 {previous}" },
				],
			},
			undefined,
			undefined,
			{} as never,
		);

		await tick();
		expect(h.getActiveCount()).toBe(4);

		while (h.pending.length > 0) {
			expect(h.getActiveCount()).toBeLessThanOrEqual(4);
			h.pending.shift()?.resolve();
			await tick();
		}

		await Promise.all([p1, p2, singleCall, chainCall]);
		expect(h.getMaxObservedConcurrent()).toBe(4);
	});
});
