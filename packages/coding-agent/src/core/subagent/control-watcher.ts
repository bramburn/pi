/**
 * Child-side control watcher (issue #1047, Stage 2).
 *
 * The parent files a request into the run's control inbox (`control.ts`); this
 * module is the other half — a child session polling that inbox and applying
 * what it finds to itself. It runs inside the child process, where there is no
 * in-memory handle to interrupt and no registry row to read a pid from, so a
 * file is the only channel available.
 *
 * The watcher is deliberately thin: it claims a request (an exclusive rename,
 * so exactly one watcher delivers it), records the transition, and hands the
 * operation to a session adapter. Every decision about what "steer" or "stop"
 * means for a live session belongs to that adapter, which keeps this file
 * testable without spawning anything — the tests pass a recording stub.
 *
 * Failure posture: an apply that throws is recorded as `failed` and the request
 * stays claimed. Re-queuing it would replay a poison request forever; a
 * recorded failure, on the other hand, shows up in the parent's `status` and can
 * be re-filed deliberately. Nothing the timer callback does is allowed to
 * propagate — a throwing session adapter must not take the child's event loop
 * down with it.
 */

import {
	type ControlAction,
	type ControlRequest,
	claimControlRequest,
	controlDirFromEnv,
	listControlRequests,
	pruneControlDir,
	recordControlState,
} from "./control.ts";

/** Default poll cadence. Sub-second polling buys nothing against a model turn. */
export const CONTROL_WATCHER_INTERVAL_MS = 1000;

/** Requests applied in one pass. Bounds a tick against a backed-up inbox. */
export const CONTROL_WATCHER_MAX_PER_TICK = 4;

/** Passes between prune sweeps. Keeps a long run's inbox from growing forever. */
export const CONTROL_WATCHER_PRUNE_EVERY_TICKS = 60;

/** The operations a watcher can perform on its own session. */
export interface ControlWatcherSession {
	/** Deliver new instruction text to the running session. */
	steer(text: string): void | Promise<void>;
	/** Interrupt the current turn without ending the session. */
	interrupt(): void | Promise<void>;
	/** End the session. */
	stop(): void | Promise<void>;
}

export interface ControlWatcherOptions {
	/** Absolute path to the run's control dir. Explicit — never inferred. */
	controlDir: string;
	session: ControlWatcherSession;
	intervalMs?: number;
	/** Cap on requests handled per tick. */
	maxPerTick?: number;
	/** Apply at most this many ticks between prune sweeps. 0 disables pruning. */
	pruneEveryTicks?: number;
	/** Structured logging sink. Errors are reported here, never thrown. */
	log?: (message: string) => void;
}

export interface ControlWatcher {
	/** Begin polling. Idempotent. */
	start(): void;
	/** Stop polling. Idempotent, safe from any state. */
	stop(): void;
	/**
	 * One poll pass: claim and apply pending requests. Resolves with the number
	 * of requests handled. Exposed for tests and for callers that want to drive
	 * the watcher from their own clock.
	 */
	tick(): Promise<number>;
	isRunning(): boolean;
}

/** What one applied request did, for logging and tests. */
export interface ControlWatcherOutcome {
	id: string;
	action: ControlAction;
	applied: boolean;
	note?: string;
}

function requestText(request: ControlRequest): string {
	return request.text ?? "";
}

export function createControlWatcher(options: ControlWatcherOptions): ControlWatcher {
	const { controlDir, session } = options;
	const intervalMs = options.intervalMs ?? CONTROL_WATCHER_INTERVAL_MS;
	const maxPerTick = options.maxPerTick ?? CONTROL_WATCHER_MAX_PER_TICK;
	const pruneEveryTicks = options.pruneEveryTicks ?? CONTROL_WATCHER_PRUNE_EVERY_TICKS;
	const log = options.log;

	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;
	/** Set once stop() is requested: further passes must not touch the session. */
	let stopped = false;
	/** A slow apply must not overlap the next tick. */
	let busy = false;
	let ticks = 0;

	const note = (message: string): void => {
		try {
			log?.(message);
		} catch {
			// A logging sink is never worth losing a delivery over.
		}
	};

	/** Run the session operation a request asks for. */
	async function apply(request: ControlRequest): Promise<{ applied: boolean; note?: string }> {
		if (request.action === "steer") {
			const text = requestText(request);
			if (text === "") return { applied: false, note: "empty steer message" };
			await session.steer(text);
			return { applied: true };
		}
		if (request.action === "interrupt") {
			await session.interrupt();
			return { applied: true };
		}
		await session.stop();
		return { applied: true, note: "session stop requested" };
	}

	async function handle(request: ControlRequest): Promise<ControlWatcherOutcome> {
		const claimed = claimControlRequest(controlDir, request.id);
		if (claimed === undefined) {
			// Another claimer won the rename. Its receipts are the record.
			return { id: request.id, action: request.action, applied: false, note: "already claimed" };
		}
		recordControlState(controlDir, { id: request.id, action: request.action, state: "queued", by: "child" });

		let outcome: { applied: boolean; note?: string };
		try {
			outcome = await apply(claimed);
		} catch (error) {
			outcome = { applied: false, note: error instanceof Error ? error.message : String(error) };
		}

		recordControlState(controlDir, {
			id: request.id,
			action: request.action,
			state: outcome.applied ? "delivered" : "failed",
			by: "child",
			...(outcome.note === undefined ? {} : { note: outcome.note }),
		});
		note(
			`control ${outcome.applied ? "delivered" : "failed"} ${request.action} id=${request.id}${
				outcome.note === undefined ? "" : ` note=${outcome.note}`
			}`,
		);
		return {
			id: request.id,
			action: request.action,
			applied: outcome.applied,
			...(outcome.note === undefined ? {} : { note: outcome.note }),
		};
	}

	async function tick(): Promise<number> {
		if (stopped || busy) return 0;
		busy = true;
		let handled = 0;
		try {
			const pending = listControlRequests(controlDir).slice(0, Math.max(0, maxPerTick));
			for (const request of pending) {
				const outcome = await handle(request);
				if (outcome.applied) handled += 1;
				// A stop that just landed ends this pass. Requests left in the
				// inbox stay pending for the parent to read or re-file.
				if (request.action === "stop") break;
			}
			ticks += 1;
			if (pruneEveryTicks > 0 && ticks % pruneEveryTicks === 0) {
				const pruned = pruneControlDir(controlDir);
				if (pruned.requestsRemoved > 0 || pruned.receiptLinesDropped > 0) {
					note(
						`control inbox pruned: ${pruned.requestsRemoved} request(s), ${pruned.receiptLinesDropped} receipt line(s)`,
					);
				}
			}
		} catch (error) {
			note(`control watcher error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			busy = false;
		}
		return handled;
	}

	function start(): void {
		if (running || stopped) return;
		running = true;
		timer = setInterval(
			() => {
				void tick();
			},
			Math.max(50, intervalMs),
		);
		// The watcher follows its session's lifetime; it must never be the reason
		// a child process stays alive.
		timer.unref?.();
	}

	function stop(): void {
		stopped = true;
		running = false;
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	return { start, stop, tick, isRunning: () => running };
}

/**
 * Open a watcher for this process when the environment names a control dir.
 * Returns undefined when it does not, which is the ordinary (non-subagent) case
 * — the caller wires nothing and nothing polls.
 */
export function createControlWatcherFromEnv(
	session: ControlWatcherSession,
	env: NodeJS.ProcessEnv = process.env,
	extra: Omit<Partial<ControlWatcherOptions>, "controlDir" | "session"> = {},
): ControlWatcher | undefined {
	const controlDir = controlDirFromEnv(env);
	if (controlDir === undefined) return undefined;
	return createControlWatcher({ controlDir, session, ...extra });
}
