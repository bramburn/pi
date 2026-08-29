import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionDefaultFromHeader, type SessionHeader, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager new-session default", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-session-default-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("getSessionDefaultFromHeader", () => {
		it("returns null for a null header", () => {
			expect(getSessionDefaultFromHeader(null)).toBeNull();
		});

		it("returns null for an empty header object", () => {
			const header: SessionHeader = {
				type: "session",
				id: "test",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
			};
			expect(getSessionDefaultFromHeader(header)).toEqual({ model: undefined, thinkingLevel: undefined });
		});

		it("returns the model and thinking level when present", () => {
			const header: SessionHeader = {
				type: "session",
				id: "test",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinkingLevel: "high",
			};
			expect(getSessionDefaultFromHeader(header)).toEqual({
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinkingLevel: "high",
			});
		});

		it("returns partial preferences when only one field is set", () => {
			const header: SessionHeader = {
				type: "session",
				id: "test",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
				model: { provider: "openai", modelId: "gpt-5" },
			};
			expect(getSessionDefaultFromHeader(header)).toEqual({
				model: { provider: "openai", modelId: "gpt-5" },
				thinkingLevel: undefined,
			});
		});
	});

	describe("setSessionDefault", () => {
		it("writes the model to the in-memory header", () => {
			const session = SessionManager.inMemory();
			session.newSession();

			session.setSessionDefault({
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
			});

			const header = session.getHeader();
			expect(header).not.toBeNull();
			expect(header?.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		});

		it("persists the model to the session file on disk", () => {
			const session = SessionManager.inMemory();
			const newPath = session.newSession();
			expect(newPath).toBeUndefined(); // in-memory sessions do not get a file

			// For a real file, use SessionManager.create and a non-persist file
			const real = SessionManager.create(testDir, testDir, { id: "test-id" });
			real.setSessionDefault({
				model: { provider: "openai", modelId: "gpt-5" },
			});

			const realFile = real.getSessionFile();
			expect(realFile).toBeDefined();
			expect(existsSync(realFile as string)).toBe(true);

			const firstLine = readFileSync(realFile as string, "utf-8").split("\n")[0];
			const header = JSON.parse(firstLine) as SessionHeader;
			expect(header.model).toEqual({ provider: "openai", modelId: "gpt-5" });
		});

		it("updates an existing model on subsequent calls", () => {
			const session = SessionManager.inMemory();
			session.newSession();
			session.setSessionDefault({ model: { provider: "openai", modelId: "gpt-5" } });
			session.setSessionDefault({ model: { provider: "anthropic", modelId: "claude-haiku-4-5" } });

			expect(session.getHeader()?.model).toEqual({
				provider: "anthropic",
				modelId: "claude-haiku-4-5",
			});
		});
	});

	describe("newSession with model option", () => {
		it("seeds the header with the initial model", () => {
			const session = SessionManager.inMemory();
			session.newSession({
				model: { provider: "openai", modelId: "gpt-5" },
			});

			const header = session.getHeader();
			expect(header?.model).toEqual({ provider: "openai", modelId: "gpt-5" });
		});
	});
});
