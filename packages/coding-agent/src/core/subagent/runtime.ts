/**
 * Bun runtime surface for the native subagent capability.
 *
 * pi is Bun-only. This module is the single place that declares the Bun APIs
 * used by the subagent runner, so the rest of the module can import a typed
 * `bun` object instead of either (a) reaching for a `Bun` global that
 * `tsconfig.base.json` does not type (it pins `"types": ["node"]`) or (b)
 * importing the untyped `"bun"` module.
 *
 * Anything Bun does not provide a typed equivalent of (`node:path`, `node:os`)
 * is imported directly and is not a fallback — those modules are Bun
 * implementations, not Node-only code.
 */

/**
 * A minimal reader handle over a Bun subprocess stream.
 *
 * Declared rather than reusing the DOM `ReadableStream` because the root
 * tsconfig has `lib: ["ES2024"]` (no DOM) and pins `types: ["node"]`.
 */
export interface BunReadableStream {
	getReader(): {
		read(): Promise<{ done: boolean; value?: Uint8Array }>;
		cancel(reason?: unknown): Promise<void>;
		releaseLock(): void;
	};
}

export interface BunSubprocess {
	pid: number | undefined;
	stdout: BunReadableStream | null;
	stderr: BunReadableStream | null;
	/**
	 * Resolves to the signal name as a string (e.g. `"SIGTERM"`), not a number.
	 * Verified under Bun 1.4 on Windows: `kill("SIGTERM")` -> `exited` 143 and
	 * `signalCode` `"SIGTERM"`. Note `exited` is 128+signal, not null, when the
	 * child is signalled.
	 */
	readonly signalCode: Promise<string | null>;
	readonly exited: Promise<number>;
	/**
	 * Accepts a signal name (`"SIGTERM"`), a raw number (`9`, `15`), or
	 * `undefined` for SIGTERM. Verified under Bun. A value outside the POSIX
	 * signal set throws `ERR_INVALID_ARG_TYPE`.
	 */
	kill(signal?: number | NodeJS.Signals): void;
}

export interface BunSpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: "ignore" | "pipe";
	stdout?: "pipe";
	stderr?: "pipe";
}

/** Output of a `Bun.$` invocation made with `.quiet()` or `.nothrow()`. */
export interface BunShellResult {
	exitCode: number;
	stdout: Uint8Array;
	stderr: Uint8Array;
	text(): Promise<string>;
}

export interface BunShellCommand {
	/** Suppress stdio inheritance and return the full result instead of throwing. */
	quiet(): Promise<BunShellResult>;
	/** Like `quiet()` but keeps the failure as a rejected promise. */
	nothrow(): Promise<BunShellResult>;
	env(vars: Record<string, string>): BunShellCommand;
}

export type BunShell = (command: TemplateStringsArray, ...values: unknown[]) => BunShellCommand;

export interface BunFileLike {
	exists(): Promise<boolean>;
	text(): Promise<string>;
	delete(): Promise<void>;
}

export interface BunApi {
	spawn(command: string[], options?: BunSpawnOptions): BunSubprocess;
	file(path: string): BunFileLike;
	write(path: string, data: string | Uint8Array): Promise<number>;
	env: Record<string, string | undefined>;
	$: BunShell;
}

const candidate = (globalThis as { Bun?: BunApi }).Bun;

/**
 * The Bun API object.
 *
 * Throws when called off Bun. Callers that must degrade gracefully (tool
 * registration) check {@link isBunRuntime} first; the runner itself does not,
 * because a subagent run is only ever started by code that already gated on it.
 */
export function getBun(): BunApi {
	if (!candidate || typeof candidate.spawn !== "function") {
		throw new Error("Native subagents require the Bun runtime (pi is Bun-only).");
	}
	return candidate;
}

/**
 * Whether the current runtime is Bun.
 *
 * Used at registration time so a non-Bun runtime never registers a tool it
 * cannot execute.
 */
export function isBunRuntime(): boolean {
	return typeof candidate?.spawn === "function";
}
