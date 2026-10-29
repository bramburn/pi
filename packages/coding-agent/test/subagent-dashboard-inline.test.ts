/**
 * REQ-O02: live inline subagent runs are visible while they run.
 *
 * `toggleBackgroundDashboard` and `openBackgroundLogOverlay` are exercised on
 * the real `InteractiveMode` prototype against a stand-in `this` (the same
 * pattern as the navigation suite in subagent-background-dashboard.test.ts):
 * inline runs come from `listInlineSubagentRuns()` (a tool definition with a
 * stub runner registered in this process), background rows from the registry,
 * and the inline run's log comes from its own `<inlineTaskDir>/log.jsonl`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen } from "@bramburn/qi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	_resetBackgroundRegistryForTests,
	type BackgroundTask,
	getBackgroundRegistry,
} from "../src/core/subagent/background.ts";
import { clearBackgroundLogOverlay, type ExperimentsUi, UI_KEYS } from "../src/core/subagent/experiments-dashboard.ts";
import { createSubagentToolDefinition, INLINE_TASK_DIR_NAME } from "../src/core/subagent/subagent-tool.ts";
import type { InFlightRun, SubagentRunner } from "../src/core/subagent/types.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("REQ-O02: inline runs in the dashboard and log overlay", () => {
	let agentDir: string | undefined;
	const previous = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		initTheme("dark");
		agentDir = mkdtempSync(join(tmpdir(), "pi-inline-dash-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		_resetBackgroundRegistryForTests();
	});

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		if (previous === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previous;
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	interface DashboardSelf {
		defaultEditor: CustomEditor;
		createExperimentsUi(): ExperimentsUi;
		bgDashboardOpen: boolean;
		bgDashboardEscapeHandler?: () => void;
		bgDashboardSelectedRow: number;
		bgDashboardTasks: BackgroundTask[];
		bgLogOverlayOpen: boolean;
		bgLogOverlayEscapeHandler?: () => void;
		toggleBackgroundDashboard(): void;
		collectDashboardTasks(): BackgroundTask[];
		closeBackgroundDashboard(): void;
		setBackgroundDashboardNavigation(active: boolean): void;
		moveBackgroundDashboardSelection(delta: number): void;
		openBackgroundLogOverlay(task: BackgroundTask): void;
		closeBackgroundLogOverlay(): void;
	}

	function makeSelf(): {
		self: DashboardSelf;
		lines: (key: string) => string[] | undefined;
	} {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		const widgets = new Map<string, string[] | undefined>();
		const ui = {
			mode: "tui" as const,
			setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
			setStatus: () => {},
			notify: () => {},
		};
		const methods = InteractiveMode.prototype as unknown as DashboardSelf;
		const self = {
			defaultEditor: editor,
			createExperimentsUi: () => ui as never,
			bgDashboardOpen: false,
			bgDashboardEscapeHandler: undefined,
			bgDashboardSelectedRow: 0,
			bgDashboardTasks: [] as BackgroundTask[],
			bgLogOverlayOpen: false,
			bgLogOverlayEscapeHandler: undefined,
			toggleBackgroundDashboard: methods.toggleBackgroundDashboard,
			collectDashboardTasks: methods.collectDashboardTasks,
			closeBackgroundDashboard: methods.closeBackgroundDashboard,
			setBackgroundDashboardNavigation: methods.setBackgroundDashboardNavigation,
			moveBackgroundDashboardSelection: methods.moveBackgroundDashboardSelection,
			openBackgroundLogOverlay: methods.openBackgroundLogOverlay,
			closeBackgroundLogOverlay: methods.closeBackgroundLogOverlay,
		} satisfies DashboardSelf;
		return { self, lines: (key) => widgets.get(key) };
	}

	/** Register a tool definition whose runner reports one live inline run. */
	function registerInlineRunner(runs: InFlightRun[]): void {
		const runner: SubagentRunner = {
			async run() {
				throw new Error("not used in this suite");
			},
			listRunning: () => runs.map((run) => ({ ...run })),
		};
		createSubagentToolDefinition(process.cwd(), { runner });
	}

	it("shows the inline run beside background rows, newest first (REQ-O02.2)", () => {
		const inlineRun: InFlightRun = {
			runId: "run-uuid-1",
			role: "scout",
			task: "scan the repo",
			cwd: process.cwd(),
			startedAt: "2026-10-05T12:00:00Z",
			pid: 4321,
			model: "prov/model-1",
		};
		registerInlineRunner([inlineRun]);

		const registry = getBackgroundRegistry();
		const now = new Date().toISOString();
		registry.add({
			id: "bg_1",
			kind: "pi-subprocess",
			mode: "single",
			role: "explorer",
			label: "explorer (background)",
			task: "old background row",
			status: "running",
			startedAt: "2026-10-05T10:00:00Z",
			lastEventAt: now,
			lastOutput: "",
			cwd: process.cwd(),
		});

		const { self } = makeSelf();
		self.toggleBackgroundDashboard();
		expect(self.bgDashboardOpen).toBe(true);
		// Inline run is newest; both namespaces appear.
		expect(self.bgDashboardTasks.map((t) => t.id)).toEqual(["run-uuid-1", "bg_1"]);

		const inline = self.bgDashboardTasks[0];
		expect(inline?.status).toBe("running");
		expect(inline?.mode).toBe("single");
		expect(inline?.role).toBe("scout");
		expect(inline?.pid).toBe(4321);
		expect(inline?.label).toContain("inline");

		self.closeBackgroundDashboard();
	});

	it("opens the inline run's own log.jsonl in the log overlay (REQ-O02.1)", () => {
		const runId = "run-uuid-2";
		registerInlineRunner([
			{
				runId,
				role: "reviewer",
				task: "review the diff",
				cwd: process.cwd(),
				startedAt: new Date().toISOString(),
			},
		]);

		// The runner tees lifecycle events to <inlineTaskDir>/<runId>/log.jsonl.
		const logDir = join(agentDir as string, INLINE_TASK_DIR_NAME, runId);
		mkdirSync(logDir, { recursive: true });
		writeFileSync(
			join(logDir, "log.jsonl"),
			[
				JSON.stringify({ at: "2026-10-05T12:00:00Z", type: "SPAWN", pid: 4321 }),
				JSON.stringify({ at: "2026-10-05T12:00:05Z", type: "EXIT", exitCode: 0, killed: false }),
				"",
			].join("\n"),
			"utf8",
		);

		const { self, lines } = makeSelf();
		const inlineTask = self.collectDashboardTasks().find((t) => t.id === runId);
		expect(inlineTask).toBeDefined();
		expect(inlineTask?.status).toBe("running");

		self.openBackgroundLogOverlay(inlineTask as BackgroundTask);
		expect(self.bgLogOverlayOpen).toBe(true);
		const rendered = (lines(UI_KEYS.BG_LOG_KEY) ?? []).map(stripAnsi).join("\n");
		expect(rendered).toContain(runId);
		expect(rendered).toContain("SPAWN");

		// Same bounded reader contract as background logs: a missing inline log
		// reads as an empty overlay rather than throwing.
		self.closeBackgroundLogOverlay();
		const missing: BackgroundTask = {
			id: "run-uuid-missing",
			kind: "pi-subprocess",
			mode: "single",
			role: "ghost",
			label: "ghost (inline)",
			task: "no log",
			status: "running",
			startedAt: new Date().toISOString(),
			lastEventAt: new Date().toISOString(),
			lastOutput: "",
			cwd: process.cwd(),
		};
		expect(() => self.openBackgroundLogOverlay(missing)).not.toThrow();
		expect(self.bgLogOverlayOpen).toBe(true);
		self.closeBackgroundLogOverlay();
		clearBackgroundLogOverlay({
			mode: "tui",
			setWidget: () => {},
			setStatus: () => {},
			notify: () => {},
		} as never);
	});
});
