// Tests for scripts/publish-with-skip.mjs.
//
// The wrapper distinguishes three failure modes:
// - success (exit 0)
// - version already on npm (HTTP 403 "You cannot publish over") -> exit 0
// - ENEEDAUTH (auth issue, likely missing trusted-publisher config) -> exit non-zero with a hint
// - any other failure -> exit non-zero

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./publish-with-skip.mjs", import.meta.url));

async function withTempDir(fn) {
	const dir = await mkdtemp(join(tmpdir(), "pi-publish-with-skip-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function run(pkgDir, args) {
	return spawnSync(process.execPath, [scriptPath, pkgDir, ...args], { encoding: "utf8" });
}

// Write a one-off child script to disk and invoke it. Inline `-e` strings
// fight with the shell quoting that publish-with-skip.mjs uses on
// Windows (`shell: true`), so a real file is the safer test fixture.
async function writeChildScript(dir, name, source) {
	const path = join(dir, name);
	await writeFile(path, source, "utf8");
	return path;
}

test("exits 0 when the child exits 0", async () => {
	await withTempDir(async (pkgDir) => {
		const child = await writeChildScript(pkgDir, "ok.cjs", `process.exit(0);\n`);
		const result = run(pkgDir, [process.execPath, child]);
		assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);
	});
});

test("exits 0 when npm publish fails with 'You cannot publish over the previously published versions'", async () => {
	await withTempDir(async (pkgDir) => {
		const child = await writeChildScript(
			pkgDir,
			"already-published.cjs",
			`const msg = [
  "npm error code 403",
  "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@bramburn%2fpi-foo - You cannot publish over the previously published versions: 0.1.0.",
  "",
].join("\\n");
process.stderr.write(msg);
process.exit(1);
`,
		);
		const result = run(pkgDir, [process.execPath, child]);
		assert.equal(result.status, 0, `expected skip-as-success, got: ${result.stderr}`);
		assert.match(result.stderr, /version already on npm, treating as success/);
	});
});

test("exits non-zero with a hint on ENEEDAUTH", async () => {
	await withTempDir(async (pkgDir) => {
		const child = await writeChildScript(
			pkgDir,
			"eneedauth.cjs",
			`const msg = [
  "npm error code ENEEDAUTH",
  "npm error need auth This command requires you to be logged in to https://registry.npmjs.org/",
  "",
].join("\\n");
process.stderr.write(msg);
process.exit(1);
`,
		);
		const result = run(pkgDir, [process.execPath, child]);
		assert.notEqual(result.status, 0, "ENEEDAUTH must surface as a step failure");
		assert.match(result.stderr, /ENEEDAUTH/);
		assert.match(result.stderr, /trusted publisher/i);
	});
});

test("exits non-zero with the child status for unrelated failures", async () => {
	await withTempDir(async (pkgDir) => {
		const child = await writeChildScript(
			pkgDir,
			"explode.cjs",
			`process.stderr.write("something exploded\\n");
process.exit(42);
`,
		);
		const result = run(pkgDir, [process.execPath, child]);
		assert.equal(result.status, 42);
		assert.doesNotMatch(result.stderr, /trusted publisher/i);
	});
});

test("usage error when called with no args", () => {
	const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
	assert.equal(result.status, 2);
	assert.match(result.stderr, /usage:/);
});
