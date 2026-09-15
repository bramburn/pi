import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

function toBashSingleQuotedArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

function createInheritedStdioCommand(pidFile: string): string {
	const pidFileArg = toBashSingleQuotedArg(pidFile);
	// Use the literal `node` binary (resolved from PATH) instead of
	// `process.execPath` so the inner detached child does not break on Windows
	// under bun, where `process.execPath` resolves to a path containing spaces
	// (e.g. `C:\Program Files\...\bun.exe`) and cmd.exe splits on those spaces.
	return (
		'node -e "' +
		"const fs=require('fs');" +
		"const {spawn}=require('child_process');" +
		"const child=spawn('node',['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});" +
		"fs.writeFileSync(process.argv[1], String(child.pid));" +
		"child.unref();" +
		"console.log('child-exiting');" +
		'" ' +
		pidFileArg
	);
}

function cleanupDetachedChild(pidFile: string): void {
	if (!existsSync(pidFile)) {
		return;
	}

	const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	if (Number.isFinite(pid) && pid > 0) {
		try {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
		} catch {
			// Process may have already exited.
		}
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);

		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

// NOTE: this file tests Windows-specific bash child-process close handling.
// The two tests inside target a known issue with `node -e "..."` invocations
// where Windows cmd.exe path-splitting (on paths containing spaces) prevents
// the inner child from starting. We use `describe.skipIf(win32-only)` so the
// file is exercised whenever the test runner is on Windows.
// TODO: track Windows bash test flake in follow-up issue
describe.skipIf(process.platform !== "win32")("Windows child-process close handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-bash-close-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("executeBash resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "executor-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();

		try {
			const result = await withTimeout(
				executeBashWithOperations(command, process.cwd(), createLocalBashOperations(), {
					signal: controller.signal,
				}),
				3000,
				() => {
					controller.abort();
				},
			);

			expect(result.output).toContain("child-exiting");
			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
		} finally {
			controller.abort();
			cleanupDetachedChild(pidFile);
		}
	});

	it("bash tool resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "tool-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();
		const bashTool = createBashTool(testDir);

		try {
			const result = await withTimeout(bashTool.execute("test-call", { command }, controller.signal), 3000, () => {
				controller.abort();
			});

			expect(getTextOutput(result)).toContain("child-exiting");
		} finally {
			controller.abort();
			cleanupDetachedChild(pidFile);
		}
	});
});
