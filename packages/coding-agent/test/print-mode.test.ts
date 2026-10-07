import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundRegistryForTests,
	type BackgroundTask,
	backgroundTaskDir,
	getBackgroundRegistry,
} from "../src/core/subagent/background.ts";
import {
	CONTROL_DIR_ENV,
	controlDirFor,
	listControlRequests,
	readControlReceipts,
	writeControlRequest,
} from "../src/core/subagent/control.ts";
import { CONTROL_WATCHER_INTERVAL_MS } from "../src/core/subagent/control-watcher.ts";
import { postSupervisorRequest, supervisorDirFor } from "../src/core/subagent/supervisor-channel.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	steer: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	sendCustomMessage: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

/** The handoff entry `runPrintMode` emits in json mode. */
type HandoffMessage = {
	customType: string;
	display: boolean;
	content: Array<{ type: string; text: string }>;
	details: {
		runs: Array<{
			taskId: string;
			taskDir: string;
			controlDir: string;
			supervisorDir: string;
			requests: Array<{ id: string; action: string; state: string; pending: boolean }>;
			openQuestions: string[];
		}>;
	};
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		steer: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		sendCustomMessage: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

function runningTask(id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	const now = new Date().toISOString();
	const task: BackgroundTask = {
		id,
		kind: "pi-subprocess",
		mode: "single",
		role: "worker",
		label: id,
		task: "read the module and report",
		status: "running",
		startedAt: now,
		lastEventAt: now,
		lastOutput: "",
		cwd: process.cwd(),
		...overrides,
	};
	getBackgroundRegistry().add(task);
	return task;
}

function handoffMessage(sendCustomMessage: ReturnType<typeof vi.fn>): HandoffMessage | undefined {
	const call: unknown[] | undefined = sendCustomMessage.mock.calls[0];
	return call?.[0] as HandoffMessage | undefined;
}

let agentDir = "";
const previousAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	// The child-side watcher is env-gated; keep it dark unless a test asks for it.
	delete process.env[CONTROL_DIR_ENV];
	// The handoff reads the background registry, which lives under the agent dir.
	// Point it at a sandbox so the suite never touches a real session's runs.
	agentDir = mkdtempSync(join(tmpdir(), "pi-print-mode-"));
	process.env[ENV_AGENT_DIR] = agentDir;
	_resetBackgroundRegistryForTests();
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	_resetBackgroundRegistryForTests();
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});

describe("runPrintMode control-plane handoff", () => {
	it("names the live run's inbox and outbox in json mode", async () => {
		const task = runningTask("bg-handoff");
		const controlDir = controlDirFor(backgroundTaskDir(task.id));
		const supervisorDir = supervisorDirFor(backgroundTaskDir(task.id));
		const requestId = writeControlRequest(controlDir, { action: "steer", text: "use the adapter" }).request.id;
		const questionId = postSupervisorRequest(supervisorDir, { question: "which entry point?" }).request.id;

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.anything(), { triggerTurn: false });

		const message = handoffMessage(session.sendCustomMessage);
		expect(message?.customType).toBe("subagent-control-plane");
		expect(message?.display).toBe(false);

		const [run] = message?.details.runs ?? [];
		expect(run?.taskId).toBe(task.id);
		expect(run?.controlDir).toBe(controlDir);
		expect(run?.supervisorDir).toBe(supervisorDir);
		expect(run?.requests.map((row) => row.id)).toEqual([requestId]);
		expect(run?.requests[0]?.state).toBe("requested");
		expect(run?.openQuestions).toEqual([questionId]);

		const text = message?.content.map((part) => part.text).join("\n") ?? "";
		expect(text).toContain(`run ${task.id} is still running`);
		expect(text).toContain(`control inbox: ${controlDir}`);
		expect(text).toContain(`supervisor outbox: ${supervisorDir}`);
		expect(text).toContain(`control id=${requestId} action=steer state=requested awaiting child`);
		expect(text).toContain(`unanswered questions: ${questionId}`);
	});

	it("emits nothing in json mode when no run is live", async () => {
		runningTask("bg-settled", { status: "completed", exitCode: 0 });

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("emits nothing in text mode even with a live run", async () => {
		runningTask("bg-text-mode");

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
		});

		expect(exitCode).toBe(0);
		expect(session.sendCustomMessage).not.toHaveBeenCalled();
	});
});

describe("runPrintMode child control inbox", () => {
	it("applies a filed steer request to the live session", async () => {
		const controlDir = controlDirFor(backgroundTaskDir("bg-child"));
		const requestId = writeControlRequest(controlDir, { action: "steer", text: "use the adapter" }).request.id;
		process.env[CONTROL_DIR_ENV] = controlDir;

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		// End the turn when the steer lands, so the assertion rests on ordering
		// rather than on how long the process happened to sleep.
		let releaseTurn = () => {};
		const turn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		session.steer = vi.fn(async () => {
			releaseTurn();
		});
		session.prompt = vi.fn(async () => {
			await turn;
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "hello",
		});

		expect(exitCode).toBe(0);
		await vi.waitFor(() => expect(session.steer).toHaveBeenCalledWith("use the adapter"), {
			timeout: CONTROL_WATCHER_INTERVAL_MS * 5,
			interval: 25,
		});
		const receipts = readControlReceipts(controlDir).filter((receipt) => receipt.id === requestId);
		// Filing records "requested" from the parent; the child answers with the rest.
		expect(receipts.map((receipt) => receipt.state)).toEqual(["requested", "queued", "delivered"]);
		expect(receipts.map((receipt) => receipt.by)).toEqual(["parent", "child", "child"]);
		// Claiming a request moves it out of the inbox, so it cannot run twice.
		expect(listControlRequests(controlDir)).toHaveLength(0);
	});

	it("does not touch the session when no control dir is named", async () => {
		const controlDir = controlDirFor(backgroundTaskDir("bg-child-dark"));
		writeControlRequest(controlDir, { action: "steer", text: "use the adapter" });

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "hello",
		});

		expect(exitCode).toBe(0);
		expect(session.steer).not.toHaveBeenCalled();
		expect(listControlRequests(controlDir)).toHaveLength(1);
	});

	it("stops polling once print mode returns", async () => {
		const controlDir = controlDirFor(backgroundTaskDir("bg-child-stop"));
		process.env[CONTROL_DIR_ENV] = controlDir;

		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "hello",
		});
		// The run is over: a request filed afterwards must stay pending.
		writeControlRequest(controlDir, { action: "steer", text: "too late" });
		await new Promise((resolve) => setTimeout(resolve, CONTROL_WATCHER_INTERVAL_MS * 2));

		expect(session.steer).not.toHaveBeenCalled();
		expect(readControlReceipts(controlDir).filter((receipt) => receipt.by === "child")).toHaveLength(0);
		expect(listControlRequests(controlDir)).toHaveLength(1);
	});
});
