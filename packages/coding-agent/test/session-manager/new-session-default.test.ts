import type { Message } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionDefaultFromHeader, type SessionHeader, SessionManager } from "../../src/core/session-manager.ts";

function makeAssistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

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

		it("does not break the first flush after creating the file on a fresh session", () => {
			// Regression test: setSessionDefault() rewrites (and thereby creates)
			// the session file before the first assistant message. The rewrite
			// must mark the session as flushed, otherwise _persist() later tries
			// to exclusively create the existing file and throws EEXIST.
			const real = SessionManager.create(testDir, testDir);
			real.setSessionDefault({
				model: { provider: "openai", modelId: "gpt-5" },
			});

			const realFile = real.getSessionFile();
			expect(realFile).toBeDefined();
			expect(existsSync(realFile as string)).toBe(true);

			expect(() => real.appendMessage(makeAssistantMessage("hi"))).not.toThrow();

			const lines = readFileSync(realFile as string, "utf-8")
				.trim()
				.split("\n");
			expect(lines).toHaveLength(2);
			const header = JSON.parse(lines[0]) as SessionHeader;
			expect(header.type).toBe("session");
			expect(header.model).toEqual({ provider: "openai", modelId: "gpt-5" });
			const assistantEntry = JSON.parse(lines[1]) as { type: string; message: { role: string } };
			expect(assistantEntry.type).toBe("message");
			expect(assistantEntry.message.role).toBe("assistant");
		});

		it("persists entries appended after a model switch on a fresh session", () => {
			// User-reported repro: start a new session, switch the model before the
			// first assistant reply, then let the session continue. The switch
			// materializes the session file; the following entries must append to
			// it, not crash trying to re-create it (EEXIST).
			const real = SessionManager.create(testDir, testDir);
			real.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });

			real.setSessionDefault({ model: { provider: "openai", modelId: "gpt-5" } });

			expect(() => real.appendMessage(makeAssistantMessage("hi"))).not.toThrow();

			const lines = readFileSync(real.getSessionFile() as string, "utf-8")
				.trim()
				.split("\n");
			expect(lines).toHaveLength(3);
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

	describe("per-session model isolation", () => {
		it("switching the model in one session leaves other sessions unchanged", () => {
			const sessionA = SessionManager.create(testDir, testDir);
			const sessionB = SessionManager.create(testDir, testDir);
			sessionB.setSessionDefault({ model: { provider: "anthropic", modelId: "claude-haiku-4-5" } });

			// Switch model in session A only.
			sessionA.setSessionDefault({ model: { provider: "openai", modelId: "gpt-5" } });

			expect(sessionA.getHeader()?.model).toEqual({ provider: "openai", modelId: "gpt-5" });
			expect(sessionB.getHeader()?.model).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });

			// Resuming each session restores its own model: session A continues
			// with the switched model, session B keeps the model it had.
			const reopenedA = SessionManager.open(sessionA.getSessionFile() as string);
			const reopenedB = SessionManager.open(sessionB.getSessionFile() as string);
			expect(reopenedA.getHeader()?.model).toEqual({ provider: "openai", modelId: "gpt-5" });
			expect(reopenedB.getHeader()?.model).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
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
