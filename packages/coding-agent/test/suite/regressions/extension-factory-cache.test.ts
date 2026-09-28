import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

interface TestState {
	moduleLoads?: number;
	factoryRuns?: number;
}

function state(): TestState {
	const global = globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState };
	if (!global.__extensionFactoryCacheTest) {
		global.__extensionFactoryCacheTest = {};
	}
	return global.__extensionFactoryCacheTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState }).__extensionFactoryCacheTest;
}

function writeCountingExtension(filePath: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;

export default function () {
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
}

describe("extension factory cache", () => {
	const roots: string[] = [];

	function fixture(name: string) {
		const root = join(tmpdir(), `pi-extension-cache-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		return { root, cwd, agentDir };
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetState();
		clearExtensionCache();
	});

	it("caches extension modules for cached same-cwd loads but reruns factories", async () => {
		const { root, cwd } = fixture("same-cwd");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		const first = await loadExtensionsCached([extensionPath], cwd);
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(state().moduleLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
		expect(first.extensions[0]).not.toBe(second.extensions[0]);
		expect(first.runtime).not.toBe(second.runtime);
	});

	it("does not cache direct loadExtensions calls", async () => {
		const { root, cwd } = fixture("direct");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensions([extensionPath], cwd);
		await loadExtensions([extensionPath], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("keeps factory cache across resource loader reloads (mtime-revalidated)", async () => {
		const { cwd, agentDir } = fixture("reload");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		const extPath = join(extensionDir, "counting.ts");
		writeCountingExtension(extPath);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		await loader.reload();
		await loader.reload();

		// Issue #967 (fork): reload() no longer force-clears the factory cache.
		// Unchanged files keep their cached module (moduleLoads stays 1) while
		// factories still re-run (factoryRuns = 2).
		expect(state().moduleLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);

		// Editing the extension file busts the cache via mtime revalidation.
		writeCountingExtension(extPath);
		// Ensure mtime actually advanced (some filesystems have coarse granularity).
		const st = await import("node:fs");
		const prev = st.statSync(extPath);
		st.utimesSync(extPath, prev.atime, new Date(Date.now() + 10));

		await loader.reload();
		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(3);
	});

	it("keeps the cache scoped to one cwd", async () => {
		const { root } = fixture("cross-cwd");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensionsCached([extensionPath], firstCwd);
		await loadExtensionsCached([extensionPath], secondCwd);
		await loadExtensionsCached([extensionPath], secondCwd);

		// Issue #967 (fork): per-cwd slots replace the single-cwd global cache.
		// Each cwd gets its own slot (first visit to a cwd imports once), but the
		// crucial part: revisiting secondCwd does NOT clear firstCwd's cache.
		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(3);
	});

	it("retains cache across alternating cwds up to the slot bound", async () => {
		const { root } = fixture("alternating-cwd");
		const cwds = ["a", "b", "c", "d", "e"].map((n) => {
			const dir = join(root, n);
			mkdirSync(dir, { recursive: true });
			return dir;
		});
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		// Each new cwd imports once (its own slot); revisits are cached.
		await loadExtensionsCached([extensionPath], cwds[0]); // import 1
		await loadExtensionsCached([extensionPath], cwds[1]); // import 2
		await loadExtensionsCached([extensionPath], cwds[2]); // import 3
		await loadExtensionsCached([extensionPath], cwds[3]); // import 4
		await loadExtensionsCached([extensionPath], cwds[0]); // cached (recent)
		const loadsAfterWarm = state().moduleLoads ?? 0;
		// 5th distinct cwd evicts the LRU slot (cwds[1]); cwds[0] survives (recent).
		await loadExtensionsCached([extensionPath], cwds[4]); // import 5 (new slot)
		await loadExtensionsCached([extensionPath], cwds[0]); // cached
		const loadsNoEvictForRecent = state().moduleLoads;
		await loadExtensionsCached([extensionPath], cwds[1]); // evicted → import 6

		expect(loadsAfterWarm).toBe(4);
		expect(loadsNoEvictForRecent).toBe(loadsAfterWarm + 1);
		expect(state().moduleLoads).toBe(loadsAfterWarm + 2);
	});
});
