/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { reportProviderError } from "../core/sentry.ts";
import { type BackgroundTask, backgroundTaskDir, getBackgroundRegistry } from "../core/subagent/background.ts";
import { controlDirFor, summarizeControlRequests } from "../core/subagent/control.ts";
import { type ControlWatcher, createControlWatcherFromEnv } from "../core/subagent/control-watcher.ts";
import { listOpenSupervisorRequests, supervisorDirFor } from "../core/subagent/supervisor-channel.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

// ============================================================================
// Control-plane handoff for `pi --mode json` (#1047, #1048)
// ============================================================================

/**
 * Print mode returns as soon as the prompted turn settles, while detached
 * background subagent runs keep going in their own processes. Once this
 * process exits, the only bridge to a live run is its on-disk control inbox
 * and supervisor outbox, so the JSON stream ends with one entry naming both
 * directories and whatever is already filed or asked. A headless consumer
 * can steer, stop, or answer from the stream alone instead of guessing the
 * agent directory layout, and a later session replays the entry from history
 * like any other custom message.
 */
const CONTROL_PLANE_CUSTOM_TYPE = "subagent-control-plane";

/** One control request, as reported to a JSON consumer. */
export interface ControlPlaneRequestSummary {
	id: string;
	action: string;
	/** Newest receipt state, or "requested" when no receipt line exists yet. */
	state: string;
	/** True while the request file still sits in requests/, unclaimed. */
	pending: boolean;
	note?: string;
}

/** One live background run plus the two directories that address it. */
export interface ControlPlaneRunSummary {
	taskId: string;
	status: string;
	taskDir: string;
	controlDir: string;
	supervisorDir: string;
	requests: ControlPlaneRequestSummary[];
	/** Ids of contact_supervisor questions that have no answer yet. */
	openQuestions: string[];
}

/** Read each live run's inbox and outbox. Pure filesystem work — no spawning. */
export function summarizeControlPlaneRuns(tasks: BackgroundTask[]): ControlPlaneRunSummary[] {
	return tasks.map((task) => {
		const taskDir = backgroundTaskDir(task.id);
		const controlDir = controlDirFor(taskDir);
		const supervisorDir = supervisorDirFor(taskDir);
		const requests = summarizeControlRequests(controlDir).map(
			(row): ControlPlaneRequestSummary => ({
				id: row.request.id,
				action: row.request.action,
				state: row.state ?? "requested",
				pending: row.pending,
				...(row.note === undefined ? {} : { note: row.note }),
			}),
		);
		const openQuestions = listOpenSupervisorRequests(supervisorDir).map((request) => request.id);
		return {
			taskId: task.id,
			status: task.status,
			taskDir,
			controlDir,
			supervisorDir,
			requests,
			openQuestions,
		};
	});
}

/** Human-readable half of the handoff entry: one block per run. */
export function formatControlPlaneHandoff(runs: ControlPlaneRunSummary[]): string {
	const blocks = runs.map((run) => {
		const lines = [
			`run ${run.taskId} is still ${run.status}`,
			`control inbox: ${run.controlDir}`,
			`supervisor outbox: ${run.supervisorDir}`,
		];
		if (run.requests.length === 0) {
			lines.push("control requests: none filed");
		} else {
			for (const request of run.requests) {
				lines.push(
					[
						`control id=${request.id}`,
						`action=${request.action}`,
						`state=${request.state}`,
						request.pending ? "awaiting child" : "claimed by child",
						request.note === undefined ? "" : `note=${request.note}`,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
		}
		if (run.openQuestions.length > 0) {
			lines.push(`unanswered questions: ${run.openQuestions.join(", ")}`);
		}
		return lines.join("\n");
	});
	return ["Background subagent runs are still in flight:", ...blocks].join("\n\n");
}

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	let controlWatcher: ControlWatcher | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		controlWatcher?.stop();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	const reportControlPlaneHandoff = async (): Promise<void> => {
		const runs = summarizeControlPlaneRuns(getBackgroundRegistry().listRunning());
		if (runs.length === 0) return;
		await session.sendCustomMessage(
			{
				customType: CONTROL_PLANE_CUSTOM_TYPE,
				content: [{ type: "text", text: formatControlPlaneHandoff(runs) }],
				display: false,
				details: { runs },
			},
			{ triggerTurn: false },
		);
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		// Child side of the control plane (#1047): a backgrounded run is a `pi --mode json`
		// process, so this is where its own session exists. When the spawner names a control
		// inbox with PI_SUBAGENT_CONTROL_DIR, poll it and apply the filed action to this
		// process's session: steer text joins the live turn, interrupt and stop abort it.
		// No env var means no watcher and no polling, which is the ordinary case.
		controlWatcher = createControlWatcherFromEnv({
			steer: (text) => session.steer(text),
			interrupt: () => session.abort(),
			stop: () => session.abort(),
		});
		controlWatcher?.start();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		if (mode === "json") {
			// Best-effort handoff for detached runs that outlive this process: it only
			// informs the consumer, so a read failure must never change the exit code.
			await reportControlPlaneHandoff().catch(() => undefined);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					// Forward the provider error to Sentry when opted in. The agent's
					// stream contract requires adapters to encode failures as a normal
					// AssistantMessage with stopReason: "error", so this never reaches
					// the uncaughtException handler.
					reportProviderError({
						message: assistantMsg.errorMessage ?? `Request ${assistantMsg.stopReason}`,
						stopReason: assistantMsg.stopReason,
						provider: assistantMsg.provider,
						model: assistantMsg.model,
					});
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
