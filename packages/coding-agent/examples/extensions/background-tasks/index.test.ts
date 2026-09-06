/**
 * Tests for the background-tasks extension.
 *
 * Tests the registry, status injector, and extension factory
 * using real filesystem operations on temporary directories.
 */

import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addTask, getTask, listTasks, readRegistry, readTaskLogTail, removeTask, updateTask } from "./registry.ts";
import { buildStatusSection } from "./status-injector.ts";

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe("registry", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-"));
	});

	afterEach(() => {
		try {
			rmdirSync(dir, { recursive: true });
		} catch {
			/* ignore */
		}
	});

	it("reads empty registry when file does not exist", () => {
		const reg = readRegistry(dir);
		expect(reg.tasks).toEqual([]);
		expect(reg.version).toBe(1);
	});

	it("adds and retrieves a task", () => {
		const task = createSampleTask("test-1");
		addTask(dir, task);
		const retrieved = getTask(dir, "test-1");
		expect(retrieved).toBeDefined();
		expect(retrieved?.name).toBe("test-1");
		expect(retrieved?.status).toBe("running");
	});

	it("updates a task and persists", () => {
		addTask(dir, createSampleTask("test-2"));
		const updated = updateTask(dir, "test-2", { status: "completed", resultSummary: "done" });
		expect(updated?.status).toBe("completed");
		expect(updated?.resultSummary).toBe("done");

		// Read back from disk
		const retrieved = getTask(dir, "test-2");
		expect(retrieved?.status).toBe("completed");
	});

	it("lists tasks by status", () => {
		addTask(dir, { ...createSampleTask("a"), status: "running" });
		addTask(dir, { ...createSampleTask("b"), status: "completed" });
		addTask(dir, { ...createSampleTask("c"), status: "running" });

		expect(listTasks(dir, "running")).toHaveLength(2);
		expect(listTasks(dir, "completed")).toHaveLength(1);
		expect(listTasks(dir, "all")).toHaveLength(3);
	});

	it("removes a task", () => {
		addTask(dir, createSampleTask("del-me"));
		expect(getTask(dir, "del-me")).toBeDefined();
		expect(removeTask(dir, "del-me")).toBe(true);
		expect(getTask(dir, "del-me")).toBeUndefined();
		expect(removeTask(dir, "del-me")).toBe(false);
	});

	it("survives a corrupted registry by returning empty", () => {
		const regPath = join(dir, "background-tasks", "registry.json");
		const parent = join(dir, "background-tasks");
		if (!existsSync(parent)) {
			// Create the directory manually
			const fs = require("node:fs");
			fs.mkdirSync(parent, { recursive: true });
		}
		require("node:fs").writeFileSync(regPath, "{not json");
		const reg = readRegistry(dir);
		expect(reg.tasks).toEqual([]);
	});

	it("appends and reads task logs", () => {
		const { appendTaskLog } = require("./registry.ts");
		addTask(dir, createSampleTask("log-test"));
		appendTaskLog(dir, "log-test", { type: "TEST", msg: "hello" });
		appendTaskLog(dir, "log-test", { type: "TEST", msg: "world" });

		const tail = readTaskLogTail(dir, "log-test", 5);
		expect(tail).toHaveLength(2);
		expect(tail[0]).toContain("hello");
		expect(tail[1]).toContain("world");
	});
});

// ---------------------------------------------------------------------------
// Status injector tests
// ---------------------------------------------------------------------------

describe("status-injector", () => {
	it("returns empty-ish section when no tasks", () => {
		const section = buildStatusSection([]);
		expect(section.hasRunning).toBe(false);
		expect(section.text).toContain("No background tasks");
	});

	it("shows running tasks in a table", () => {
		const tasks = [
			createTaskForInjector("agent-1", "researcher", "running", "Found 3 papers..."),
			createTaskForInjector("agent-2", "coder", "running", "Compiling..."),
		];
		const section = buildStatusSection(tasks);
		expect(section.hasRunning).toBe(true);
		expect(section.text).toContain("agent-1");
		expect(section.text).toContain("researcher");
		expect(section.text).toContain("Found 3 papers");
		expect(section.text).toContain("background_status");
		expect(section.text).toContain("background_wait");
		expect(section.text).toContain("background_cancel");
	});

	it("shows completed and failed tasks separately", () => {
		const tasks = [
			createTaskForInjector("a", "researcher", "completed", undefined, "All good"),
			createTaskForInjector("b", "coder", "failed", undefined, undefined, "OOM"),
		];
		const section = buildStatusSection(tasks);
		expect(section.text).toContain("Recently Completed");
		expect(section.text).toContain("Failed / Cancelled");
		expect(section.text).toContain("OOM");
	});
});

// ---------------------------------------------------------------------------
// Extension factory tests
// ---------------------------------------------------------------------------

describe("extension factory", () => {
	it("registers expected tools and commands", () => {
		const pi = makeMockPi();
		const factory = require("./index.ts").default;
		factory(pi);

		expect(pi.tools.has("background_task")).toBe(true);
		expect(pi.tools.has("background_status")).toBe(true);
		expect(pi.tools.has("background_wait")).toBe(true);
		expect(pi.tools.has("background_cancel")).toBe(true);

		expect(pi.commands.has("bg-tasks")).toBe(true);
		expect(pi.commands.has("bg-clear")).toBe(true);

		expect(pi.handlers.has("session_start")).toBe(true);
		expect(pi.handlers.has("before_agent_start")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSampleTask(id: string) {
	return {
		id,
		name: id,
		role: "tester",
		objective: "test task",
		status: "running" as const,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		command: "pi",
		args: ["--mode", "json"],
		cwd: "/tmp",
		outputPath: `/tmp/${id}`,
	};
}

function createTaskForInjector(
	id: string,
	role: string,
	status: "running" | "completed" | "failed" | "cancelled",
	lastOutput?: string,
	resultSummary?: string,
	errorMessage?: string,
) {
	return {
		id,
		name: id,
		role,
		objective: "test",
		status,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		command: "pi",
		args: [],
		cwd: "/tmp",
		outputPath: `/tmp/${id}`,
		lastOutput,
		resultSummary,
		errorMessage,
	};
}

interface MockPi {
	tools: Map<string, unknown>;
	commands: Map<string, unknown>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}

function makeMockPi(): MockPi {
	const pi: MockPi = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
	};

	(pi as any).registerTool = (t: { name: string }) => pi.tools.set(t.name, t);
	(pi as any).registerCommand = (name: string, def: unknown) => pi.commands.set(name, def);
	(pi as any).on = (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
		const list = pi.handlers.get(event) ?? [];
		list.push(handler);
		pi.handlers.set(event, list);
	};

	return pi;
}
