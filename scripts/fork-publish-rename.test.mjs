import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./fork-publish-rename.mjs", import.meta.url));

// A child script written into the package dir. We invoke it as a real file
// (no shell-interpreted command line) so semicolons and quotes inside the
// JS source are not eaten by cmd.exe. fork-publish-rename.mjs sets
// `shell: true` on Windows, but Node's spawnSync still receives the
// args as an array — it joins them into a single command line only for
// display, the actual execve still gets the array.
const CHILD_CAPTURE_SOURCE = `const fs = require("node:fs");
fs.writeFileSync("in-flight.json", JSON.stringify(JSON.parse(fs.readFileSync("package.json", "utf8"))));
process.exit(0);
`;

const CHILD_FAIL_SOURCE = `process.exit(42);
`;

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

async function readManifestRaw(root, relativeDirectory) {
	return await readFile(join(root, relativeDirectory, "package.json"), "utf8");
}

// Run the rename script with a child that runs a real JS file in the
// package dir. The child is either a capture script (writes the in-flight
// package.json to in-flight.json before exit) or a fail script (exits 42).
async function runRename(root, packageDir, { captureManifest = false, failChild = false } = {}) {
	const childSource = failChild ? CHILD_FAIL_SOURCE : CHILD_CAPTURE_SOURCE;
	const childFile = join(root, packageDir, failChild ? "fail-child.cjs" : "capture-child.cjs");
	await writeFile(childFile, childSource, "utf8");

	const result = spawnSync(process.execPath, [scriptPath, join(root, packageDir), process.execPath, childFile], {
		cwd: root,
		encoding: "utf8",
	});

	if (!captureManifest) return { result, manifest: null };

	const inFlightPath = join(root, packageDir, "in-flight.json");
	const manifest = JSON.parse(await readFile(inFlightPath, "utf8"));
	await rm(inFlightPath);
	return { result, manifest };
}

test("rewrites name, workspace deps, and upstream repository.url", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-rename-"));
	try {
		const originalManifest = {
			name: "@earendil-works/pi-coding-agent",
			version: "0.84.5",
			dependencies: {
				"@earendil-works/pi-agent-core": "^0.84.5",
				"@earendil-works/pi-ai": "^0.84.5",
				"@earendil-works/pi-client": "^0.84.5",
				"@earendil-works/pi-protocol": "^0.84.5",
				"@earendil-works/pi-tui": "^0.84.5",
				"@mariozechner/clipboard": "0.3.9",
				chalk: "5.6.2",
			},
			peerDependencies: {
				"@earendil-works/pi-ai": "^0.84.5",
			},
			optionalDependencies: {
				"@earendil-works/pi-ai": "0.84.5",
			},
			devDependencies: {
				shx: "0.4.0",
				"@earendil-works/pi-telemetry": "^0.84.5",
			},
			repository: {
				type: "git",
				url: "git+https://github.com/earendil-works/pi.git",
				directory: "packages/coding-agent",
			},
		};
		await writeManifest(root, "packages/coding-agent", originalManifest);

		const { result, manifest } = await runRename(root, "packages/coding-agent", { captureManifest: true });

		assert.equal(result.status, 0, `script failed: ${result.stderr}`);
		assert.match(result.stdout, /renamed: .* -> @bramburn\/pi-coding-agent \(deps: 8 rewrites, repo: rewritten\)/);
		assert.match(result.stdout, /restored: /);

		// The in-flight manifest seen by `npm publish`:
		assert.equal(manifest.name, "@bramburn/pi-coding-agent");
		assert.equal(manifest.repository.url, "git+https://github.com/bramburn/pi.git");
		// Every workspace dep is now @bramburn/pi-*.
		assert.ok(manifest.dependencies["@bramburn/pi-agent-core"]);
		assert.ok(manifest.dependencies["@bramburn/pi-ai"]);
		assert.ok(manifest.dependencies["@bramburn/pi-client"]);
		assert.ok(manifest.dependencies["@bramburn/pi-protocol"]);
		assert.ok(manifest.dependencies["@bramburn/pi-tui"]);
		// Non-earendil deps are untouched.
		assert.equal(manifest.dependencies["@mariozechner/clipboard"], "0.3.9");
		assert.equal(manifest.dependencies.chalk, "5.6.2");
		// peerDependencies + optionalDependencies are also rewritten.
		assert.ok(manifest.peerDependencies["@bramburn/pi-ai"]);
		assert.ok(manifest.optionalDependencies["@bramburn/pi-ai"]);
		// devDependencies is rewritten.
		assert.ok(manifest.devDependencies["@bramburn/pi-telemetry"]);
		// No @earendil-works/pi-* keys remain in any dep section.
		for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
			for (const key of Object.keys(manifest[section] || {})) {
				assert.ok(!key.startsWith("@earendil-works/"), `${section}.${key} should have been renamed`);
			}
		}

		// The on-disk package.json is restored to the original.
		const restored = await readManifest(root, "packages/coding-agent");
		assert.deepEqual(restored, originalManifest);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("preserves third-party earendil scope (e.g. @earendil-works/gondolin) and registry aliases", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-rename-"));
	try {
		const originalManifest = {
			name: "@earendil-works/pi-coding-agent",
			version: "0.84.5",
			dependencies: {
				"@earendil-works/pi-ai": "^0.84.5",
				"@earendil-works/gondolin": "0.12.0",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@0.1.0",
			},
			repository: {
				type: "git",
				url: "git+https://github.com/earendil-works/pi.git",
			},
		};
		await writeManifest(root, "packages/coding-agent", originalManifest);

		const { result, manifest } = await runRename(root, "packages/coding-agent", { captureManifest: true });

		assert.equal(result.status, 0, `script failed: ${result.stderr}`);
		// Workspace dep renamed.
		assert.ok(manifest.dependencies["@bramburn/pi-ai"]);
		// Third-party earendil scope (gondolin) is NOT a workspace package, so
		// it must stay.
		assert.equal(manifest.dependencies["@earendil-works/gondolin"], "0.12.0");
		// Registry alias value is preserved verbatim — the value starts with
		// `npm:` and is a deliberate third-party rewrite, not a workspace link.
		assert.equal(manifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@0.1.0");
		// dep count: only 1 rewrite (the workspace @earendil-works/pi-ai dep).
		assert.match(result.stdout, /deps: 1 rewrite, repo: rewritten/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("leaves repository.url alone when it is already the fork URL", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-rename-"));
	try {
		const originalManifest = {
			name: "@earendil-works/pi-ai",
			version: "0.84.5",
			dependencies: {
				"@earendil-works/pi-telemetry": "^0.84.5",
			},
			repository: {
				type: "git",
				url: "git+https://github.com/bramburn/pi.git",
				directory: "packages/ai",
			},
		};
		await writeManifest(root, "packages/ai", originalManifest);

		const { result, manifest } = await runRename(root, "packages/ai", { captureManifest: true });

		assert.equal(result.status, 0, `script failed: ${result.stderr}`);
		assert.equal(manifest.repository.url, "git+https://github.com/bramburn/pi.git");
		assert.match(result.stdout, /repo: unchanged/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("handles a package with no deps and no repository (no-op sections)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-rename-"));
	try {
		const originalManifest = {
			name: "@earendil-works/pi-tui",
			version: "0.84.5",
		};
		await writeManifest(root, "packages/tui", originalManifest);

		const { result, manifest } = await runRename(root, "packages/tui", { captureManifest: true });

		assert.equal(result.status, 0, `script failed: ${result.stderr}`);
		assert.equal(manifest.name, "@bramburn/pi-tui");
		assert.match(result.stdout, /deps: 0 rewrites, repo: unchanged/);

		const restored = await readManifest(root, "packages/tui");
		assert.deepEqual(restored, originalManifest);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("exits non-zero with a clear message when name is not under @earendil-works/pi-", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-rename-"));
	try {
		await writeManifest(root, "packages/something", {
			name: "@somebody/else",
			version: "1.0.0",
		});

		// Pass a no-op child as a real file.
		const childFile = join(root, "packages/something", "noop.cjs");
		await writeFile(childFile, `process.exit(0);\n`, "utf8");

		const result = spawnSync(
			process.execPath,
			[scriptPath, join(root, "packages/something"), process.execPath, childFile],
			{ cwd: root, encoding: "utf8" },
		);

		assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
		assert.match(result.stderr, /not under @earendil-works\/pi-/);

		// Original file is unchanged (we never wrote).
		const onDisk = JSON.parse(await readManifestRaw(root, "packages/something"));
		assert.equal(onDisk.name, "@somebody/else");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("restores the original package.json even when the child exits non-zero", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-rename-"));
	try {
		const originalManifest = {
			name: "@earendil-works/pi-coding-agent",
			version: "0.84.5",
			dependencies: {
				"@earendil-works/pi-ai": "^0.84.5",
			},
			repository: {
				type: "git",
				url: "git+https://github.com/earendil-works/pi.git",
			},
		};
		await writeManifest(root, "packages/coding-agent", originalManifest);

		const { result } = await runRename(root, "packages/coding-agent", { failChild: true });

		assert.equal(result.status, 42, `expected child exit 42 to propagate, got ${result.status}`);
		assert.match(result.stdout, /renamed: .* -> @bramburn\/pi-coding-agent/);
		assert.match(result.stdout, /restored: /);

		// The on-disk file is the original — no half-written state left behind.
		const onDisk = await readManifestRaw(root, "packages/coding-agent");
		assert.equal(onDisk, `${JSON.stringify(originalManifest, null, "\t")}\n`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
