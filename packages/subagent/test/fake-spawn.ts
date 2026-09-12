/**
 * Test utilities for the @earendil-works/pi-subagent package.
 *
 * Re-exports the in-memory spawn/gIT/registry fakes plus a mock ExtensionAPI
 * stub. Consumed by unit tests under `test/**/*.test.ts`.
 */

import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";

export interface SpawnInvocation {
	command: string;
	args: string[];
	options: {
		cwd?: string;
		shell?: boolean;
		stdio?: Array<"ignore" | "pipe" | "inherit">;
		windowsHide?: boolean;
		signal?: AbortSignal;
	};
}

export interface FakeSpawnHandle {
	stdout: Readable;
	stderr: Readable;
	kill: (signal?: NodeJS.Signals) => boolean;
	pid?: number;
	on: (event: "close" | "error", listener: (...args: unknown[]) => void) => FakeSpawnHandle;
}

export interface FakeSpawn {
	handle: FakeSpawnHandle;
	write: (chunk: string) => void;
	close: (code: number | null, signal?: NodeJS.Signals) => void;
	emitError: (err: Error) => void;
	kill: (signal?: NodeJS.Signals) => boolean;
	invocations: SpawnInvocation[];
}

/**
 * Build an in-memory fake of `child_process.spawn`. The returned handle
 * captures every call to the real spawn; tests can write to stdout/stderr
 * and emit close/error events as if a real subprocess was running.
 */
export function createFakeSpawn(opts: { pid?: number; signal?: AbortSignal } = {}): FakeSpawn {
	const invocations: SpawnInvocation[] = [];
	const stdout = new EventEmitter() as unknown as Readable;
	const stderr = new EventEmitter() as unknown as Readable;
	const procEmitter = new EventEmitter();

	let killCalled = false;
	const handle: FakeSpawnHandle = {
		stdout,
		stderr,
		pid: opts.pid ?? 12345,
		kill(signal?: NodeJS.Signals) {
			killCalled = true;
			procEmitter.emit("close", null, signal ?? "SIGTERM");
			return true;
		},
		on(event, listener) {
			procEmitter.on(event, listener);
			return handle;
		},
	};

	const write = (chunk: string): void => {
		(stdout as unknown as EventEmitter).emit("data", Buffer.from(chunk));
	};
	const close = (code: number | null, signal?: NodeJS.Signals): void => {
		procEmitter.emit("close", code, signal);
	};
	const emitError = (err: Error): void => {
		procEmitter.emit("error", err);
	};
	const kill = (signal?: NodeJS.Signals): boolean => handle.kill(signal);

	const capture = (command: string, args: string[], options: SpawnInvocation["options"]): FakeSpawnHandle => {
		invocations.push({ command, args, options });
		return handle;
	};

	return { handle, write, close, emitError, kill, invocations: invocations as SpawnInvocation[] } as FakeSpawn & {
		_capture: typeof capture;
	} as unknown as FakeSpawn;
}

/**
 * Captures the function that should be invoked instead of `child_process.spawn`.
 * Tests install this via `vi.mock("node:child_process", ...)` and assert on the
 * invocations list.
 */
export type SpawnFn = (command: string, args: string[], options: SpawnInvocation["options"]) => FakeSpawnHandle;