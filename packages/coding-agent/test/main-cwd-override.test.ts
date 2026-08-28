import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { applyCwdOverride, shouldBlockInteractiveNonTTY } from "../src/main.ts";

let workDir: string;
let originalCwd: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	originalCwd = process.cwd();
	workDir = mkdtempSync(join(tmpdir(), "pi-cwd-test-"));
	process.chdir(workDir);
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code: number | string | null | undefined) => {
		throw new Error(`__exit__:${String(code)}`);
	});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(workDir, { recursive: true, force: true });
	exitSpy.mockRestore();
	errSpy.mockRestore();
});

describe("applyCwdOverride", () => {
	it("is a no-op when cwdArg is undefined", () => {
		applyCwdOverride(undefined);
		expect(process.cwd()).toBe(workDir);
	});

	it("chdirs to an absolute path that exists", () => {
		const target = join(workDir, "sub");
		mkdirSync(target);
		applyCwdOverride(target);
		expect(process.cwd()).toBe(target);
	});

	it("resolves a relative path against the current cwd", () => {
		const target = join(workDir, "nested", "inner");
		mkdirSync(target, { recursive: true });
		process.chdir(workDir);
		applyCwdOverride("nested/inner");
		expect(process.cwd()).toBe(target);
	});

	it("exits with code 1 when the path does not exist", () => {
		expect(() => applyCwdOverride(join(workDir, "missing"))).toThrow(/__exit__:1/);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/--cwd path does not exist/));
	});

	it("exits with code 1 when the path is a file, not a directory", () => {
		const filePath = join(workDir, "a-file.txt");
		writeFileSync(filePath, "not a dir");
		expect(() => applyCwdOverride(filePath)).toThrow(/__exit__:1/);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/--cwd path is not a directory/));
	});
});

describe("shouldBlockInteractiveNonTTY", () => {
	it("blocks a bare interactive run when stdout is not a TTY", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs([]), false)).toBe(true);
	});

	it("never blocks when stdout is a TTY", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs([]), true)).toBe(false);
	});

	it("does not block --list-models on a non-TTY stdout", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs(["--list-models"]), false)).toBe(false);
		expect(shouldBlockInteractiveNonTTY(parseArgs(["--list-models", "mini"]), false)).toBe(false);
	});

	it("does not block --help on a non-TTY stdout", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs(["--help"]), false)).toBe(false);
	});

	it("does not block when a message was passed (print-mode intent)", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs(["hello"]), false)).toBe(false);
	});

	it("does not block for explicit non-interactive opt-ins", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs(["--print"]), false)).toBe(false);
		expect(shouldBlockInteractiveNonTTY(parseArgs(["--mode", "json"]), false)).toBe(false);
		expect(shouldBlockInteractiveNonTTY(parseArgs(["--mode", "rpc"]), false)).toBe(false);
	});

	it("does not block when a file arg was passed", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs(["@notes.md"]), false)).toBe(false);
	});

	it("does not block a continuation with an initial message", () => {
		expect(shouldBlockInteractiveNonTTY(parseArgs(["--continue", "what next?"]), false)).toBe(false);
	});
});
