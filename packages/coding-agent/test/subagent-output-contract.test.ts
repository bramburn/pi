/**
 * Output contracts for native subagents (#1045): `outputSchema` (parse + JSON
 * Schema validation of the child's final message) and `gate` (a host-run shell
 * verify command).
 *
 * The gate is exercised through the real `shell.ts` spawn path rather than a
 * stubbed `runShellLine`, because the parts worth testing are exactly the parts a
 * stub would fake: that the resolved cwd reaches the spawned process, that a
 * timeout actually kills the command, that an abort is reported as cancelled, and
 * that the per-stream cap keeps the tail. pi is Bun-only while the vitest host
 * here is node, so `runtime.ts` is replaced with a Bun-shaped facade over
 * `node:child_process` — the same technique `subagent-shell.test.ts` uses.
 *
 * The child is always a stub `SubagentRunner`: this file is about the contract
 * applied to a settled result, not about spawning a nested pi.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	BunApi,
	BunReadableStream,
	BunShell,
	BunSpawnOptions,
	BunSubprocess,
} from "../src/core/subagent/runtime.ts";
import { loadSpec, saveSpec, specsDir } from "../src/core/subagent/saved-specs.ts";
import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";
import {
	createEmptyUsage,
	DEFAULT_GATE_TIMEOUT_MS,
	GATE_OUTPUT_CAP_BYTES,
	type SubagentResult,
	type SubagentRunner,
	type SubagentRunRequest,
} from "../src/core/subagent/types.ts";

// ---------------------------------------------------------------------------
// Fake Bun: `spawn` only. `file`, `write`, and `$` throw on purpose — nothing on
// these paths should reach them, and a silent stub would hide the dependency.
// ---------------------------------------------------------------------------

vi.mock("../src/core/subagent/runtime.ts", async () => {
	const { spawn: nodeSpawn } = await import("node:child_process");

	/** Adapt a node readable to Bun's WHATWG default-reader shape. */
	function toBunStream(nodeStream: Readable | null): BunReadableStream | null {
		if (nodeStream === null) return null;
		const iterator = nodeStream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
		let finished = false;
		return {
			getReader() {
				return {
					async read(): Promise<{ done: boolean; value?: Uint8Array }> {
						if (finished) return { done: true, value: undefined };
						const next = await iterator.next();
						if (next.done === true) {
							finished = true;
							return { done: true, value: undefined };
						}
						const chunk = next.value;
						return { done: false, value: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) };
					},
					async cancel(): Promise<void> {
						finished = true;
						nodeStream.destroy();
					},
					releaseLock(): void {
						// One reader per stream, nothing to release.
					},
				};
			},
		};
	}

	function spawnAsBun(argv: string[], options: BunSpawnOptions): BunSubprocess {
		const child = nodeSpawn(argv[0], argv.slice(1), {
			cwd: options.cwd,
			// Own group on POSIX, exactly like Bun's `detached`, so the kill lands.
			detached: process.platform !== "win32" && options.detached === true,
			env: options.env as NodeJS.ProcessEnv | undefined,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let killRequested = false;
		const settled = new Promise<{ code: number; signal: string | null }>((resolve) => {
			child.on("close", (code, signal) => {
				// A signal-killed child reports a null code, so synthesize the
				// conventional 128+signum status the real shells would return.
				const inferred = signal ?? (killRequested ? "SIGTERM" : null);
				resolve({
					code: code ?? (inferred === "SIGKILL" ? 137 : inferred === "SIGTERM" ? 143 : 1),
					signal: inferred,
				});
			});
			// A missing cwd or executable arrives here instead of an exit; report it
			// as a failed command so the gate resolves rather than hanging.
			child.on("error", () => resolve({ code: 127, signal: null }));
		});
		return {
			pid: child.pid,
			stdout: toBunStream(child.stdout as Readable),
			stderr: toBunStream(child.stderr as Readable),
			signalCode: settled.then((result) => result.signal),
			exited: settled.then((result) => result.code),
			kill(signal?: number | NodeJS.Signals): void {
				killRequested = true;
				child.kill(signal as NodeJS.Signals | number);
			},
		};
	}

	function unavailable(name: string): never {
		throw new Error(`subagent fake Bun does not implement ${name}`);
	}

	const api: BunApi = {
		spawn: (argv, options) => spawnAsBun(argv, options ?? {}),
		file: (path) => unavailable(`Bun.file(${String(path)})`),
		write: (path) => unavailable(`Bun.write(${String(path)})`),
		env: process.env as Record<string, string | undefined>,
		// Bun.$ is deliberately unusable: gates always take the spawn path, so
		// reaching it here would mean production code had drifted off that contract.
		$: (() => unavailable("Bun.$")) as unknown as BunShell,
	};
	return { getBun: () => api, isBunRuntime: () => true };
});

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/** POSIX `;` versus cmd `&`: the one chaining spelling both accept. */
const isWin = process.platform === "win32";
const chain = (first: string, second: string): string => (isWin ? `${first}&${second}` : `${first}; ${second}`);
/** Blocks long enough that a timeout or abort has to fire first. */
const BLOCK = isWin ? "ping -n 60 127.0.0.1 > nul" : "sleep 60";
/** Print the current working directory. */
const PRINT_CWD = isWin ? "cd" : "pwd";
/** Dump a whole file to stdout. */
const DUMP = (name: string): string => (isWin ? `type ${name}` : `cat ${name}`);

function stubRunner(requests: SubagentRunRequest[], finalOutput: string): SubagentRunner {
	return {
		async run(request): Promise<SubagentResult> {
			requests.push(request);
			return {
				role: request.spec.role,
				task: request.task,
				exitCode: 0,
				aborted: false,
				finalOutput,
				stderr: "",
				usage: createEmptyUsage(),
				messages: [],
			};
		},
	};
}

function failingRunner(requests: SubagentRunRequest[]): SubagentRunner {
	return {
		async run(request): Promise<SubagentResult> {
			requests.push(request);
			return {
				role: request.spec.role,
				task: request.task,
				exitCode: 2,
				aborted: false,
				finalOutput: "",
				stderr: "child blew up",
				errorMessage: "Subagent crashed on purpose",
				usage: createEmptyUsage(),
				messages: [],
			};
		},
	};
}

type Params = Record<string, unknown>;

/**
 * Run one spec through single-task parallel mode. A failed single or chain
 * dispatch throws instead of handing back details, so this is how a settled
 * result — passing or failing — is inspected.
 */
async function dispatchSpec(spec: Params, runner: SubagentRunner): Promise<SubagentResult> {
	const tool = createSubagentToolDefinition(process.cwd(), { runner });
	const dispatched = (await tool.execute(
		"call-1",
		{ tasks: [spec] } as never,
		undefined,
		undefined,
		undefined as never,
	)) as { details: { results: SubagentResult[] } };
	return dispatched.details.results[0];
}

/** Dispatch expecting rejection, and assert that no child was ever spawned. */
async function dispatchExpectingThrow(params: Params): Promise<string> {
	const requests: SubagentRunRequest[] = [];
	const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner(requests, "{}") });
	let message = "expected the dispatch to reject";
	try {
		await tool.execute("call-1", params as never, undefined, undefined, undefined as never);
	} catch (error) {
		message = (error as Error).message;
	}
	expect(requests).toHaveLength(0);
	return message;
}

const samePath = (a: string, b: string): boolean =>
	a.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
	b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const REPORT = JSON.stringify({ files: ["a.ts"], ok: true });

// ---------------------------------------------------------------------------
// outputSchema
// ---------------------------------------------------------------------------

describe("subagent outputSchema contract", () => {
	it("tells the child about the schema in its system prompt and keeps the task text authored", async () => {
		const requests: SubagentRunRequest[] = [];
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: stubRunner(requests, REPORT),
		});
		const dispatched = (await tool.execute(
			"call-1",
			{
				role: "auditor",
				instructions: "Audit the diff and report.",
				outputSchema: {
					type: "object",
					properties: { files: { type: "array", items: { type: "string" } }, ok: { type: "boolean" } },
					required: ["ok"],
				},
			} as never,
			undefined,
			undefined,
			undefined as never,
		)) as { content: { type: string; text: string }[]; details: { results: SubagentResult[] } };

		expect(requests).toHaveLength(1);
		const prompt = requests[0].spec.instructions;
		expect(prompt.startsWith("Audit the diff and report.")).toBe(true);
		expect(prompt).toContain("## Required structured output");
		expect(prompt).toContain('"required"');
		// The contract block goes into the system prompt only, so `request.task`
		// (and the displayed result) keep the authored text.
		expect(requests[0].task).toBe("Audit the diff and report.");

		const result = dispatched.details.results[0];
		expect(result.structuredOutput).toEqual({ files: ["a.ts"], ok: true });
		expect(result.outputValidation).toEqual({ status: "passed", errors: [] });
		expect(result.errorMessage).toBeUndefined();
		// A successful run's model-facing text is the child's output, unchanged.
		expect(dispatched.content[0].text).toBe(REPORT);
	});

	it("finds JSON in a fenced or chatty final message", async () => {
		const runner = stubRunner([], `Here you go:\n\`\`\`json\n${REPORT}\n\`\`\`\nDone!`);
		const result = await dispatchSpec(
			{ role: "auditor", instructions: "x", outputSchema: { type: "object", required: ["ok"] } },
			runner,
		);
		expect(result.outputValidation?.status).toBe("passed");
		expect(result.structuredOutput).toEqual({ files: ["a.ts"], ok: true });
	});

	it("fails the run when the final message is not JSON and skips the gate", async () => {
		const result = await dispatchSpec(
			{
				role: "auditor",
				instructions: "x",
				outputSchema: { type: "object", required: ["ok"] },
				gate: { command: "exit 0" },
			},
			stubRunner([], "I audited it and everything looks great."),
		);
		expect(result.outputValidation?.status).toBe("failed");
		expect(result.outputValidation?.errors ?? []).toEqual([]);
		expect(result.outputValidation?.parseError).toBeTruthy();
		expect(result.structuredOutput).toBeUndefined();
		expect(result.errorMessage).toContain("was required to end with JSON");
		// Nothing to verify, so the gate never ran.
		expect(result.gate?.skipped).toBe("schema-failed");
		expect(result.gate?.exitCode).toBe(-1);
	});

	it("reports every schema error with a JSON pointer path and skips the gate", async () => {
		const result = await dispatchSpec(
			{
				role: "auditor",
				instructions: "x",
				outputSchema: {
					type: "object",
					properties: {
						files: { type: "array", items: { type: "string" } },
						ok: { type: "boolean" },
						missing: { type: "number" },
					},
					required: ["ok", "missing"],
					additionalProperties: false,
				},
				gate: { command: "exit 0" },
			},
			stubRunner([], JSON.stringify({ files: ["a.ts", 7], ok: "yes" })),
		);
		const errors = result.outputValidation?.errors ?? [];
		expect(errors.some((line) => line.includes("$.ok"))).toBe(true);
		expect(errors.some((line) => line.includes("$.files[1]"))).toBe(true);
		expect(errors.some((line) => line.includes("missing"))).toBe(true);
		expect(result.errorMessage).toContain("$.ok");
		expect(result.gate?.skipped).toBe("schema-failed");
	});

	it("caps the schema in the child prompt but validates against all of it", async () => {
		const requests: SubagentRunRequest[] = [];
		const properties: Record<string, unknown> = {};
		for (let i = 0; i < 900; i++) properties[`field_${i}`] = { type: "string" };
		const result = await dispatchSpec(
			{ role: "auditor", instructions: "x", outputSchema: { properties } },
			stubRunner(requests, JSON.stringify({ field_899: "x" })),
		);
		const prompt = requests[0].spec.instructions;
		expect(prompt).toContain("schema truncated in this prompt");
		expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(16 * 1024);
		// The host still knows the whole schema, which is why the tail is valid.
		expect(result.outputValidation?.status).toBe("passed");
	});

	it("does nothing when no outputSchema is declared", async () => {
		const requests: SubagentRunRequest[] = [];
		const result = await dispatchSpec(
			{ role: "writer", instructions: "Just answer." },
			stubRunner(requests, "plain prose"),
		);
		expect(requests[0].spec.instructions).toBe("Just answer.");
		expect(result.outputValidation).toBeUndefined();
		expect(result.structuredOutput).toBeUndefined();
		expect(result.errorMessage).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

describe("subagent gate contract", () => {
	it("runs the verify command on the host in the subagent cwd after a clean child", async () => {
		const result = await dispatchSpec(
			{ role: "builder", instructions: "x", gate: { command: PRINT_CWD } },
			stubRunner([], REPORT),
		);
		expect(result.gate).toBeDefined();
		expect(result.gate?.passed).toBe(true);
		expect(result.gate?.exitCode).toBe(0);
		expect(result.gate?.skipped).toBeUndefined();
		expect(result.gate?.command).toBe(PRINT_CWD);
		expect(result.gate?.cwd).toBe(process.cwd());
		// Proof the resolved cwd reached the spawned process, not just the record.
		expect(samePath(result.gate?.stdout ?? "", process.cwd())).toBe(true);
		expect(result.errorMessage).toBeUndefined();
		// A passing verdict lives in details only.
		expect(result.finalOutput).toBe(REPORT);
	});

	it("resolves gate.cwd relative to the subagent cwd, and absolute paths as-is", async () => {
		const absolute = mkdtempSync(join(tmpdir(), "pi-gate-abs-"));
		try {
			// `src`/`core` both exist under packages/coding-agent, where vitest runs.
			const nested = await dispatchSpec(
				{ role: "builder", instructions: "x", cwd: "src", gate: { command: "exit 0", cwd: "core" } },
				stubRunner([], "ok"),
			);
			expect(nested.gate?.cwd).toBe(join(process.cwd(), "src", "core"));
			expect(nested.gate?.passed).toBe(true);

			const pinned = await dispatchSpec(
				{ role: "builder", instructions: "x", gate: { command: "exit 0", cwd: absolute } },
				stubRunner([], "ok"),
			);
			expect(pinned.gate?.cwd).toBe(absolute);
		} finally {
			rmSync(absolute, { recursive: true, force: true });
		}
	});

	it("runs the gate after schema validation passes, in one dispatch", async () => {
		const result = await dispatchSpec(
			{
				role: "builder",
				instructions: "x",
				outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
				gate: { command: "exit 0" },
			},
			stubRunner([], '{"ok":true}'),
		);
		expect(result.outputValidation?.status).toBe("passed");
		expect(result.gate?.passed).toBe(true);
		expect(result.errorMessage).toBeUndefined();
	});

	it("keeps the exit code, both streams, and the duration for a failing gate", async () => {
		const result = await dispatchSpec(
			{ role: "builder", instructions: "x", gate: { command: chain("echo gate-boom", "exit 3") } },
			stubRunner([], "the child claims it is fine"),
		);
		expect(result.gate?.passed).toBe(false);
		expect(result.gate?.exitCode).not.toBe(0);
		expect(result.gate?.stdout).toContain("gate-boom");
		expect(result.gate?.durationMs).toBeLessThan(30_000);
		expect(result.errorMessage).toContain("exited with code");
		expect(result.errorMessage).toContain("The gate runs on the host");
		expect(result.errorMessage).toContain("gate stdout");
		// The child's own claims do not override the verdict.
		expect(result.finalOutput).toBe("the child claims it is fine");
	});

	it("kills a gate that blows its timeout and fails the run", async () => {
		const started = Date.now();
		const result = await dispatchSpec(
			{ role: "builder", instructions: "x", gate: { command: BLOCK, timeoutMs: 500 } },
			stubRunner([], "ok"),
		);
		expect(Date.now() - started).toBeLessThan(25_000);
		expect(result.gate?.timedOut).toBe(true);
		expect(result.gate?.passed).toBe(false);
		expect(result.errorMessage).toContain("timed out");
	});

	it("reports a cancelled gate when the dispatch aborts mid-command", async () => {
		const controller = new AbortController();
		const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner([], "ok") });
		const inflight = tool.execute(
			"call-1",
			{ tasks: [{ role: "builder", instructions: "x", gate: { command: BLOCK } }] } as never,
			controller.signal,
			undefined,
			undefined as never,
		);
		await new Promise((resolve) => setTimeout(resolve, 750));
		controller.abort();
		const dispatched = (await inflight) as { details: { results: SubagentResult[] } };
		const result = dispatched.details.results[0];
		expect(result.gate?.cancelled).toBe(true);
		expect(result.gate?.passed).toBe(false);
		expect(result.errorMessage).toContain("was cancelled");
	});

	it("caps each stream and keeps the tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-gate-cap-"));
		const big = `HEAD-MARKER-0000\n${"a".repeat(200_000)}\nTAIL-MARKER-9133`;
		writeFileSync(join(dir, "big.txt"), big);
		try {
			const result = await dispatchSpec(
				{ role: "builder", instructions: "x", cwd: dir, gate: { command: DUMP("big.txt") } },
				stubRunner([], "ok"),
			);
			const budget = Math.floor(GATE_OUTPUT_CAP_BYTES / 2);
			const stdout = result.gate?.stdout ?? "";
			expect(result.gate?.truncated).toBe(true);
			expect(stdout).toContain("TAIL-MARKER-9133");
			expect(stdout).not.toContain("HEAD-MARKER-0000");
			expect(stdout).toContain("bytes omitted from the start of this stream");
			// Only the omission note may sit on top of the per-stream budget.
			expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(budget + 96);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips the gate entirely when the child failed", async () => {
		const requests: SubagentRunRequest[] = [];
		const result = await dispatchSpec(
			{ role: "builder", instructions: "x", gate: { command: PRINT_CWD } },
			failingRunner(requests),
		);
		expect(result.gate?.skipped).toBe("child-failed");
		expect(result.gate?.passed).toBe(false);
		expect(result.gate?.stdout).toBe("");
		expect(result.gate?.cwd).toBe(process.cwd());
		// The child's own failure is what is reported, not a gate verdict.
		expect(result.errorMessage).toBe("Subagent crashed on purpose");
	});

	it("never validates the schema when the child failed", async () => {
		const result = await dispatchSpec(
			{ role: "builder", instructions: "x", outputSchema: { type: "object", required: ["ok"] } },
			failingRunner([]),
		);
		expect(result.outputValidation).toBeUndefined();
		expect(result.errorMessage).toBe("Subagent crashed on purpose");
	});

	it("treats a fast gate as passing under the default timeout", async () => {
		expect(DEFAULT_GATE_TIMEOUT_MS).toBe(300_000);
		const result = await dispatchSpec(
			{ role: "builder", instructions: "x", gate: { command: "exit 0" } },
			stubRunner([], "ok"),
		);
		expect(result.gate?.timedOut).toBe(false);
		expect(result.gate?.cancelled).toBe(false);
		expect(result.gate?.passed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Pre-flight: an unusable contract must not cost a spawn
// ---------------------------------------------------------------------------

describe("subagent contract pre-flight", () => {
	it("rejects a schema with an unsupported keyword before spawning", async () => {
		const message = await dispatchExpectingThrow({
			role: "auditor",
			instructions: "x",
			outputSchema: { type: "object", properties: { a: { $ref: "#/definitions/a" } } },
		});
		expect(message).toContain("unusable outputSchema");
		expect(message).toContain("$ref");
	});

	it("rejects an empty gate command before spawning", async () => {
		const message = await dispatchExpectingThrow({ role: "auditor", instructions: "x", gate: { command: "   " } });
		expect(message).toContain("gate with an empty command");
	});

	it("rejects a parallel batch whose second task carries a broken contract", async () => {
		const message = await dispatchExpectingThrow({
			tasks: [
				{ role: "a", instructions: "x", gate: { command: "exit 0" } },
				{ role: "b", instructions: "y", outputSchema: { type: "nope" } },
			],
		});
		expect(message).toContain("unusable outputSchema");
		expect(message).toContain('"b"');
	});

	it("refuses to combine background dispatch with an output contract", async () => {
		const schemaMessage = await dispatchExpectingThrow({
			role: "auditor",
			instructions: "x",
			outputSchema: { type: "object" },
			background: true,
		});
		expect(schemaMessage).toContain("background");
		expect(schemaMessage).toContain("outputSchema");

		const gateMessage = await dispatchExpectingThrow({
			role: "auditor",
			instructions: "x",
			gate: { command: "exit 0" },
			background: true,
		});
		expect(gateMessage).toContain("gate");
	});
});

// ---------------------------------------------------------------------------
// Saved specs
// ---------------------------------------------------------------------------

describe("saved subagent specs carry their contract", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env[ENV_AGENT_DIR];
		agentDir = mkdtempSync(join(tmpdir(), "pi-saved-contract-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("persists outputSchema and gate and reloads them", () => {
		saveSpec("verifier", {
			role: "verifier",
			instructions: "Verify the change.",
			outputSchema: { type: "object", required: ["ok"] },
			gate: { command: "exit 0", cwd: "packages", timeoutMs: 1000 },
		});
		const raw = JSON.parse(readFileSync(join(specsDir(), "verifier.json"), "utf8")) as {
			outputSchema?: unknown;
			gate?: unknown;
		};
		expect(raw.outputSchema).toEqual({ type: "object", required: ["ok"] });
		expect(raw.gate).toEqual({ command: "exit 0", cwd: "packages", timeoutMs: 1000 });

		const loaded = loadSpec("verifier");
		expect(loaded.outputSchema).toEqual({ type: "object", required: ["ok"] });
		expect(loaded.gate).toEqual({ command: "exit 0", cwd: "packages", timeoutMs: 1000 });
	});

	it("applies the saved contract when dispatched by name", async () => {
		saveSpec("verifier", {
			role: "verifier",
			instructions: "Verify the change.",
			outputSchema: { type: "object", required: ["ok"] },
			gate: { command: PRINT_CWD },
		});
		const requests: SubagentRunRequest[] = [];
		const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner(requests, '{"ok":true}') });
		const dispatched = (await tool.execute(
			"call-1",
			{ agent: "verifier" } as never,
			undefined,
			undefined,
			undefined as never,
		)) as { details: { results: SubagentResult[] } };
		const result = dispatched.details.results[0];
		expect(result.outputValidation?.status).toBe("passed");
		expect(result.structuredOutput).toEqual({ ok: true });
		expect(result.gate?.passed).toBe(true);
		expect(samePath(result.gate?.stdout ?? "", process.cwd())).toBe(true);
	});

	it("lets a top-level field override the saved contract", async () => {
		saveSpec("verifier", {
			role: "verifier",
			instructions: "Verify the change.",
			gate: { command: "exit 7" },
		});
		const tool = createSubagentToolDefinition(process.cwd(), { runner: stubRunner([], "ok") });
		const dispatched = (await tool.execute(
			"call-1",
			{ agent: "verifier", gate: { command: "exit 0" } } as never,
			undefined,
			undefined,
			undefined as never,
		)) as { details: { results: SubagentResult[] } };
		expect(dispatched.details.results[0].gate?.command).toBe("exit 0");
		expect(dispatched.details.results[0].gate?.passed).toBe(true);
	});

	it("drops a malformed contract block instead of failing the whole spec", () => {
		mkdirSync(specsDir(), { recursive: true });
		writeFileSync(
			join(specsDir(), "broken.json"),
			JSON.stringify({ role: "broken", instructions: "x", gate: { command: 5 }, outputSchema: "not-an-object" }),
		);
		const loaded = loadSpec("broken");
		expect(loaded.gate).toBeUndefined();
		expect(loaded.outputSchema).toBeUndefined();
	});
});
