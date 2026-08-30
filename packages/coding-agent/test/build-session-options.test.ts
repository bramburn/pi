import type { Model } from "@earendil-works/pi-ai";
import { mkdirSync, rmSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main.ts";

function emptyArgs(): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] };
}

function makeModel(provider: string, modelId: string): Model<any> {
	return {
		id: modelId,
		name: `${provider}/${modelId}`,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as unknown as Model<any>;
}

function makeRuntime(models: Model<any>[]): ModelRuntime {
	const byId = new Map<string, Model<any>>();
	for (const m of models) {
		byId.set(`${m.provider}\0${m.id}`, m);
	}
	return {
		getModel: (provider: string, id: string) => byId.get(`${provider}\0${id}`),
		hasConfiguredAuth: () => true,
		getModels: () => models,
	} as unknown as ModelRuntime;
}

function makeSessionManager(): { setSessionDefault: ReturnType<typeof vi.fn> } {
	return { setSessionDefault: vi.fn() } as unknown as { setSessionDefault: ReturnType<typeof vi.fn> };
}

describe("buildSessionOptions — newSessionModel preference", () => {
	let testDir: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(() => {
		testDir = `test-build-session-options-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		projectDir = `${testDir}/project`;
		agentDir = `${testDir}/agent`;
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(`${projectDir}/.pi`, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("leaves options.model undefined when no preference resolves (plan §3 safety net)", () => {
		const claude = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([claude]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
		const sessionManager = makeSessionManager();

		const { options, diagnostics } = buildSessionOptions(
			emptyArgs(),
			[],
			false,
			runtime,
			manager,
			sessionManager as any,
		);

		// Per plan §3, when no preference (lastUsed / specific / session
		// header) resolves, options.model is left undefined so the
		// createAgentSession → findInitialModel safety net can pick a
		// model. We do NOT silently substitute the global default.
		expect(options.model).toBeUndefined();
		expect(diagnostics).toEqual([]);
		expect(sessionManager.setSessionDefault).not.toHaveBeenCalled();
	});

	it("uses lastUsedModel when mode='lastUsed' and lastUsedModel is set", () => {
		const gpt = makeModel("openai", "gpt-5");
		const runtime = makeRuntime([gpt]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({ mode: "lastUsed" });
		manager.setLastUsedModel({ provider: "openai", modelId: "gpt-5" });
		const sessionManager = makeSessionManager();

		const { options } = buildSessionOptions(emptyArgs(), [], false, runtime, manager, sessionManager as any);

		expect(options.model?.provider).toBe("openai");
		expect(options.model?.id).toBe("gpt-5");
		expect(sessionManager.setSessionDefault).toHaveBeenCalledWith({
			model: { provider: "openai", modelId: "gpt-5" },
		});
	});

	it("leaves options.model undefined when mode='lastUsed' but lastUsedModel is unset", () => {
		const claude = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([claude]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({ mode: "lastUsed" });
		manager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
		const sessionManager = makeSessionManager();

		const { options, diagnostics } = buildSessionOptions(
			emptyArgs(),
			[],
			false,
			runtime,
			manager,
			sessionManager as any,
		);

		// lastUsedModel is unset, so the preference doesn't resolve.
		// No warning fires (only fires when a preference IS set but
		// unavailable). options.model stays undefined for findInitialModel.
		expect(options.model).toBeUndefined();
		expect(diagnostics).toEqual([]);
		expect(sessionManager.setSessionDefault).not.toHaveBeenCalled();
	});

	it("uses specific model when mode='specific' and the model is available", () => {
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const sonnet = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([haiku, sonnet]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({
			mode: "specific",
			specific: { provider: "anthropic", modelId: "claude-haiku-4-5" },
		});
		manager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
		const sessionManager = makeSessionManager();

		const { options, diagnostics } = buildSessionOptions(
			emptyArgs(),
			[],
			false,
			runtime,
			manager,
			sessionManager as any,
		);

		expect(options.model?.id).toBe("claude-haiku-4-5");
		expect(diagnostics).toEqual([]);
		expect(sessionManager.setSessionDefault).toHaveBeenCalledWith({
			model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
		});
	});

	it("leaves options.model undefined and emits a warning when specific model is unavailable", () => {
		const sonnet = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([sonnet]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({
			mode: "specific",
			specific: { provider: "anthropic", modelId: "claude-haiku-4-5" },
		});
		manager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
		const sessionManager = makeSessionManager();

		const { options, diagnostics } = buildSessionOptions(
			emptyArgs(),
			[],
			false,
			runtime,
			manager,
			sessionManager as any,
		);

		// Per plan §3: when the configured model is gone, options.model
		// is left undefined so findInitialModel can pick a replacement.
		expect(options.model).toBeUndefined();
		// The "configured new-session model X/Y is no longer available"
		// warning still fires (plan §4.4) so the user knows about the
		// fallback.
		expect(diagnostics.some((d) => d.type === "warning" && /claude-haiku-4-5/.test(d.message))).toBe(true);
		// setSessionDefault must not be called when no model resolved.
		expect(sessionManager.setSessionDefault).not.toHaveBeenCalled();
	});

	it("emits a warning when mode='lastUsed' but lastUsedModel is unavailable", () => {
		const sonnet = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([sonnet]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({ mode: "lastUsed" });
		manager.setLastUsedModel({ provider: "openai", modelId: "gpt-5" });
		manager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
		const sessionManager = makeSessionManager();

		const { options, diagnostics } = buildSessionOptions(
			emptyArgs(),
			[],
			false,
			runtime,
			manager,
			sessionManager as any,
		);

		// Same CRIT-4 behaviour: prefer undefined over the global default.
		expect(options.model).toBeUndefined();
		expect(diagnostics.some((d) => d.type === "warning" && /gpt-5/.test(d.message))).toBe(true);
		expect(sessionManager.setSessionDefault).not.toHaveBeenCalled();
	});

	it("respects scopedModels even when preference is set", () => {
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const sonnet = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([haiku, sonnet]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({ mode: "lastUsed" });
		manager.setLastUsedModel({ provider: "anthropic", modelId: "claude-haiku-4-5" });
		const sessionManager = makeSessionManager();

		const scoped: ScopedModel[] = [{ model: sonnet }];
		const { options } = buildSessionOptions(emptyArgs(), scoped, false, runtime, manager, sessionManager as any);

		// Preferred (haiku) is not in scope → first scoped (sonnet) wins.
		expect(options.model?.id).toBe("claude-sonnet-4-5");
		expect(sessionManager.setSessionDefault).toHaveBeenCalledWith({
			model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		});
	});

	it("uses preferred model when it is in the scoped list", () => {
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const sonnet = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([haiku, sonnet]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({ mode: "lastUsed" });
		manager.setLastUsedModel({ provider: "anthropic", modelId: "claude-haiku-4-5" });
		const sessionManager = makeSessionManager();

		const scoped: ScopedModel[] = [{ model: haiku }, { model: sonnet }];
		const { options } = buildSessionOptions(emptyArgs(), scoped, false, runtime, manager, sessionManager as any);

		expect(options.model?.id).toBe("claude-haiku-4-5");
	});

	it("--model CLI flag wins over the newSessionModel preference", () => {
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const sonnet = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([haiku, sonnet]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({
			mode: "specific",
			specific: { provider: "anthropic", modelId: "claude-haiku-4-5" },
		});
		const sessionManager = makeSessionManager();

		const args: Args = {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			messages: [],
			fileArgs: [],
			unknownFlags: new Map(),
			diagnostics: [],
		};
		const { options } = buildSessionOptions(args, [], false, runtime, manager, sessionManager as any);

		expect(options.model?.id).toBe("claude-sonnet-4-5");
		expect(sessionManager.setSessionDefault).toHaveBeenCalledWith({
			model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		});
	});

	it("session header model wins over the newSessionModel preference (resume case)", () => {
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const sonnet = makeModel("anthropic", "claude-sonnet-4-5");
		const runtime = makeRuntime([haiku, sonnet]);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setNewSessionModelPreference({
			mode: "specific",
			specific: { provider: "anthropic", modelId: "claude-haiku-4-5" },
		});
		const sessionManager = makeSessionManager();

		// Simulate a resumed session whose header pins sonnet.
		const { options } = buildSessionOptions(
			emptyArgs(),
			[],
			true, // hasExistingSession
			runtime,
			manager,
			sessionManager as any,
			{ provider: "anthropic", modelId: "claude-sonnet-4-5" },
		);

		// For a resumed session we don't auto-pick; the existing session
		// will be rehydrated from its own entries. options.model stays
		// undefined so the caller doesn't override the resumed state.
		expect(options.model).toBeUndefined();
		// setSessionDefault must NOT be called on a resumed session: the
		// header already pins a model and we must not overwrite it.
		expect(sessionManager.setSessionDefault).not.toHaveBeenCalled();
	});
});
