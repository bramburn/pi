// Tests for scripts/generate-coding-agent-shrinkwrap.mjs.
//
// The shrinkwrap script regenerates packages/coding-agent/npm-shrinkwrap.json
// from the root package-lock.json. It also runs as part of coding-agent's
// `prepublishOnly` hook inside the fork publish workflow, which means it
// has to keep working after fork-publish-rename.mjs has rewritten the
// publishing package's name and workspace deps to the @bramburn/* scope
// while the root lockfile and the other workspace package.json files
// still use @earendil-works/pi-*. Without the fork-scope swap in the
// workspace index, `npm run shrinkwrap` aborts with:
//   Cannot resolve @bramburn/pi-agent-core from root.
//   No matching lockfile entry found.
//
// Each test seeds a throwaway repo tree under the OS temp dir with a
// minimal root package-lock.json plus per-workspace package.json files,
// then invokes the script via `node ./scripts/generate-coding-agent-shrinkwrap.mjs`
// with `cwd: repoRoot`. The script reads paths relative to its own
// location (via `import.meta.url`), so we pass the real script path
// regardless of repoRoot.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./generate-coding-agent-shrinkwrap.mjs", import.meta.url));

async function runScript({ repoRoot, args = [] }) {
	// Copy the real script into the test repo so its `import.meta.url` ->
	// repoRoot resolution lands on the test repo.
	const localScript = join(repoRoot, "scripts/generate-coding-agent-shrinkwrap.mjs");
	await writeFile(localScript, await readFile(scriptPath, "utf8"));
	const result = spawnSync(process.execPath, [localScript, ...args], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return result;
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function buildRepoTree(overrides = {}) {
	// Root lockfile entries. The packages/* entries use the upstream
	// (@earendil-works/*) names; the node_modules/* link entries point
	// at them. This mirrors a real workspace install.
	const rootLock = {
		lockfileVersion: 3,
		name: "pi-monorepo",
		version: "0.0.3",
		packages: {
			"": {
				name: "pi-monorepo",
				version: "0.0.3",
				dependencies: {},
			},
			"packages/agent": {
				name: "@earendil-works/pi-agent-core",
				version: "0.85.0-b1",
				license: "MIT",
			},
			"node_modules/@earendil-works/pi-agent-core": {
				resolved: "packages/agent",
				link: true,
			},
			"packages/ai": {
				name: "@earendil-works/pi-ai",
				version: "0.85.0-b1",
				license: "MIT",
			},
			"node_modules/@earendil-works/pi-ai": {
				resolved: "packages/ai",
				link: true,
			},
			"packages/coding-agent": {
				name: "@earendil-works/pi-coding-agent",
				version: "0.85.0-b1",
				license: "MIT",
			},
			"node_modules/@earendil-works/pi-coding-agent": {
				resolved: "packages/coding-agent",
				link: true,
			},
			"node_modules/diff": {
				version: "8.0.4",
				resolved: "https://registry.npmjs.org/diff/-/diff-8.0.4.tgz",
				integrity: "sha512-",
				license: "BSD-3-Clause",
			},
			"node_modules/ignore": {
				version: "7.0.5",
				resolved: "https://registry.npmjs.org/ignore/-/ignore-7.0.5.tgz",
				integrity: "sha512-",
				license: "MIT",
			},
			"node_modules/typebox": {
				version: "1.3.7",
				resolved: "https://registry.npmjs.org/typebox/-/typebox-1.3.7.tgz",
				integrity: "sha512-",
				license: "MIT",
			},
			// Mirror the install-script packages that
			// generate-coding-agent-shrinkwrap.mjs allows, plus a
			// platform-specific optional dep, so the script's validator
			// is happy with these minimal fixtures.
			"node_modules/@google/genai": {
				version: "1.52.0",
				resolved: "https://registry.npmjs.org/@google/genai/-/genai-1.52.0.tgz",
				integrity: "sha512-",
				license: "Apache-2.0",
				hasInstallScript: true,
			},
			"node_modules/protobufjs": {
				version: "7.6.5",
				resolved: "https://registry.npmjs.org/protobufjs/-/protobufjs-7.6.5.tgz",
				integrity: "sha512-",
				license: "BSD-3-Clause",
				hasInstallScript: true,
			},
			"node_modules/better-sqlite3": {
				version: "11.9.1",
				resolved: "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-11.9.1.tgz",
				integrity: "sha512-",
				license: "MIT",
				hasInstallScript: true,
			},
			"node_modules/@mariozechner/clipboard-win32-x64-msvc": {
				version: "0.3.9",
				resolved: "https://registry.npmjs.org/@mariozechner/clipboard-win32-x64-msvc/-/clipboard-win32-x64-msvc-0.3.9.tgz",
				integrity: "sha512-",
				license: "MIT",
				os: ["win32"],
				cpu: ["x64"],
			},
		},
	};
	// packages/agent is a leaf; its only deps are non-workspace.
	const agentPackage = {
		name: "@earendil-works/pi-agent-core",
		version: "0.85.0-b1",
		license: "MIT",
		dependencies: {
			diff: "8.0.4",
			ignore: "7.0.5",
			typebox: "1.3.7",
		},
	};
	// packages/ai is a leaf.
	const aiPackage = {
		name: "@earendil-works/pi-ai",
		version: "0.85.0-b1",
		license: "MIT",
		dependencies: {},
	};
	// packages/coding-agent depends on two workspace packages, plus the
	// install-script packages and a platform-specific optional dep that
	// the shrinkwrap validator requires. After fork-publish-rename, its
	// name and its workspace deps use the @bramburn/* scope. The other
	// workspace package.json files are unchanged on disk.
	const codingAgentPackage = {
		name: "@earendil-works/pi-coding-agent",
		version: "0.85.0-b1",
		license: "MIT",
		dependencies: {
			"@earendil-works/pi-agent-core": "^0.85.0-b1",
			"@earendil-works/pi-ai": "^0.85.0-b1",
			diff: "8.0.4",
			"@google/genai": "1.52.0",
			protobufjs: "7.6.5",
			"better-sqlite3": "11.9.1",
		},
		optionalDependencies: {
			"@mariozechner/clipboard-win32-x64-msvc": "0.3.9",
		},
	};
	return {
		rootLock: overrides.rootLock ?? rootLock,
		agentPackage: overrides.agentPackage ?? agentPackage,
		aiPackage: overrides.aiPackage ?? aiPackage,
		codingAgentPackage: overrides.codingAgentPackage ?? codingAgentPackage,
	};
}

async function seedRepo(repoRoot, repo) {
	// The shrinkwrap script resolves its repo root from `import.meta.url`
	// (scriptDir/..), so we copy the script into a `scripts/` subdirectory
	// of the test repo. Without that copy, the script writes the shrinkwrap
	// next to its own on-disk location — outside the temp dir.
	await mkdir(`${repoRoot}/scripts`, { recursive: true });
	await mkdir(`${repoRoot}/packages/agent`, { recursive: true });
	await mkdir(`${repoRoot}/packages/ai`, { recursive: true });
	await mkdir(`${repoRoot}/packages/coding-agent`, { recursive: true });
	await writeJson(`${repoRoot}/package-lock.json`, repo.rootLock);
	await writeJson(`${repoRoot}/packages/agent/package.json`, repo.agentPackage);
	await writeJson(`${repoRoot}/packages/ai/package.json`, repo.aiPackage);
	await writeJson(`${repoRoot}/packages/coding-agent/package.json`, repo.codingAgentPackage);
}

async function makeRepo(overrides) {
	const root = await mkdtemp(join(tmpdir(), "pi-shrinkwrap-"));
	const repo = buildRepoTree(overrides);
	await seedRepo(root, repo);
	return root;
}

test("regenerates shrinkwrap with upstream names when no fork rename happened", async () => {
	const repoRoot = await makeRepo();
	try {
		const result = await runScript({ repoRoot });
		assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);

		const shrinkwrap = JSON.parse(
			await readFile(`${repoRoot}/packages/coding-agent/npm-shrinkwrap.json`, "utf8"),
		);
		assert.equal(shrinkwrap.name, "@earendil-works/pi-coding-agent");
		// Workspace deps resolve to the upstream-scope @earendil-works/*
		// node_modules entries, with tarball URLs under that scope.
		const agentPath = "node_modules/@earendil-works/pi-agent-core";
		assert.ok(shrinkwrap.packages[agentPath], `missing ${agentPath}`);
		assert.equal(
			shrinkwrap.packages[agentPath].resolved,
			"https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.85.0-b1.tgz",
		);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test("resolves @bramburn/* workspace deps after fork-publish-rename rewrites the publishing package.json", async () => {
	const repoRoot = await makeRepo({
		codingAgentPackage: {
			name: "@bramburn/pi-coding-agent",
			version: "0.85.0-b1",
			license: "MIT",
			dependencies: {
				"@bramburn/pi-agent-core": "^0.85.0-b1",
				"@bramburn/pi-ai": "^0.85.0-b1",
				diff: "8.0.4",
				"@google/genai": "1.52.0",
				protobufjs: "7.6.5",
				"better-sqlite3": "11.9.1",
			},
			optionalDependencies: {
				"@mariozechner/clipboard-win32-x64-msvc": "0.3.9",
			},
		},
	});
	try {
		const result = await runScript({ repoRoot });
		assert.equal(result.status, 0, `script failed: ${result.stderr}\n${result.stdout}`);
		assert.doesNotMatch(
			result.stderr + result.stdout,
			/Cannot resolve @bramburn\/pi-agent-core/,
			"shrinkwrap must resolve the post-rename fork-scope dep name back to the @earendil-works/* workspace",
		);

		const shrinkwrap = JSON.parse(
			await readFile(`${repoRoot}/packages/coding-agent/npm-shrinkwrap.json`, "utf8"),
		);
		// Top-level entry picks up the renamed package name.
		assert.equal(shrinkwrap.name, "@bramburn/pi-coding-agent");
		// Workspace deps land under the requested (fork-scope) name in the
		// shrinkwrap output — that's what consumers of the published
		// @bramburn/pi-coding-agent tarball will resolve.
		const agentPath = "node_modules/@bramburn/pi-agent-core";
		assert.ok(shrinkwrap.packages[agentPath], `missing ${agentPath}`);
		assert.equal(
			shrinkwrap.packages[agentPath].resolved,
			"https://registry.npmjs.org/@bramburn/pi-agent-core/-/pi-agent-core-0.85.0-b1.tgz",
		);
		const aiPath = "node_modules/@bramburn/pi-ai";
		assert.ok(shrinkwrap.packages[aiPath], `missing ${aiPath}`);
		// The upstream-scope entries should NOT appear — they would be
		// duplicates (same workspace, different scope).
		assert.equal(shrinkwrap.packages["node_modules/@earendil-works/pi-agent-core"], undefined);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test("--check exits 0 when the on-disk shrinkwrap matches the regenerated one (post-rename)", async () => {
	const repoRoot = await makeRepo({
		codingAgentPackage: {
			name: "@bramburn/pi-coding-agent",
			version: "0.85.0-b1",
			license: "MIT",
			dependencies: {
				"@bramburn/pi-agent-core": "^0.85.0-b1",
				"@bramburn/pi-ai": "^0.85.0-b1",
				diff: "8.0.4",
				"@google/genai": "1.52.0",
				protobufjs: "7.6.5",
				"better-sqlite3": "11.9.1",
			},
			optionalDependencies: {
				"@mariozechner/clipboard-win32-x64-msvc": "0.3.9",
			},
		},
	});
	try {
		const first = await runScript({ repoRoot });
		assert.equal(first.status, 0, `regenerate failed: ${first.stderr}\n${first.stdout}`);

		const second = await runScript({ repoRoot, args: ["--check"] });
		assert.equal(second.status, 0, `--check failed: ${second.stderr}\n${second.stdout}`);
		assert.match(second.stdout, /is up to date\./);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test("--check exits non-zero when the on-disk shrinkwrap is stale", async () => {
	const repoRoot = await makeRepo();
	try {
		// Write a deliberately wrong shrinkwrap so --check trips.
		await writeJson(`${repoRoot}/packages/coding-agent/npm-shrinkwrap.json`, {
			name: "@earendil-works/pi-coding-agent",
			version: "0.0.0",
			lockfileVersion: 3,
			packages: {},
		});

		const result = await runScript({ repoRoot, args: ["--check"] });
		assert.notEqual(result.status, 0, "--check should fail when shrinkwrap is stale");
		assert.match(result.stderr, /is out of date\./);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});
