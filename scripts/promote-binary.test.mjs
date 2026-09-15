import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScript = fileURLToPath(new URL("./promote-binary.mjs", import.meta.url));
const BINARY_NAME = process.platform === "win32" ? "pi.exe" : "pi";

function runScript(cwd) {
	return spawnSync(process.execPath, [join(cwd, "scripts", "promote-binary.mjs")], {
		cwd,
		encoding: "utf8",
	});
}

function git(args, cwd) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (status ${result.status}): ${result.stderr}`);
	}
	return result.stdout;
}

async function installScript(targetRoot) {
	const targetScripts = join(targetRoot, "scripts");
	await mkdir(targetScripts, { recursive: true });
	await copyFile(sourceScript, join(targetScripts, "promote-binary.mjs"));
}

test("main checkout is a no-op and does not touch the dist binary", async () => {
	// Synthetic main checkout: a directory whose `.git/` is a real directory
	// (the script's worktree detection checks file-vs-dir on `.git`). The
	// script's __dirname is fixed to <root>/scripts, so copy the script in.
	const root = await mkdtemp(join(tmpdir(), "pi-promote-binary-main-"));
	try {
		await mkdir(join(root, ".git"), { recursive: true });
		const distDir = join(root, "packages", "coding-agent", "dist");
		await mkdir(distDir, { recursive: true });
		const markerPath = join(distDir, BINARY_NAME);
		await writeFile(markerPath, "pi-test-marker-original\n", "utf8");
		const originalMtime = (await stat(markerPath)).mtimeMs;

		await installScript(root);

		const result = runScript(root);
		assert.equal(result.status, 0, `script failed: ${result.stderr}`);
		assert.match(result.stdout, /main checkout.*nothing to promote/);

		// mtime must be unchanged — no copy/overwrite happened.
		const afterMtime = (await stat(markerPath)).mtimeMs;
		assert.equal(afterMtime, originalMtime, "marker mtime changed; script modified the file");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("worktree with sibling layout promotes the binary to the main checkout", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-promote-binary-"));
	const mainRepo = join(root, "main");
	const siblingRepo = join(root, "sibling");
	let worktreeRegistered = false;

	try {
		git(["init", "--initial-branch=main", mainRepo], root);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], mainRepo);
		git(["worktree", "add", "-b", "wt", siblingRepo], mainRepo);
		worktreeRegistered = true;

		// Install the script into the sibling (worktree) so its __dirname
		// resolves there. This is what makes `git rev-parse --git-common-dir`
		// find the throwaway mainRepo as the common checkout.
		await installScript(siblingRepo);

		const marker = "// pi-test-binary-v1\n";
		const srcDir = join(siblingRepo, "packages", "coding-agent", "dist");
		await mkdir(srcDir, { recursive: true });
		const srcPath = join(srcDir, BINARY_NAME);
		await writeFile(srcPath, marker, "utf8");

		// Pre-create the destination directory. In the real workflow the
		// main checkout already has packages/coding-agent/dist from a prior
		// build; the script doesn't mkdir the destination itself.
		await mkdir(join(mainRepo, "packages", "coding-agent", "dist"), { recursive: true });

		const result = runScript(siblingRepo);
		assert.equal(result.status, 0, `script failed: ${result.stderr}\nstdout: ${result.stdout}`);

		// Content equality, not just existence — catches a "copy succeeded with
		// wrong content" regression.
		const dstPath = join(mainRepo, "packages", "coding-agent", "dist", BINARY_NAME);
		const dstContent = await readFile(dstPath, "utf8");
		assert.equal(dstContent, marker, "destination content mismatch");
	} finally {
		if (worktreeRegistered) {
			try {
				git(["worktree", "remove", "--force", siblingRepo], mainRepo);
			} catch {
				// On Windows the rm below can race with lingering handles; fall
				// back to a prune so the .git/worktrees/wt entry doesn't leak.
				try {
					git(["worktree", "prune"], mainRepo);
				} catch {
					// best-effort cleanup
				}
			}
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("worktree with missing source exits 2 with a clear error", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-promote-binary-"));
	const mainRepo = join(root, "main");
	const siblingRepo = join(root, "sibling");
	let worktreeRegistered = false;

	try {
		git(["init", "--initial-branch=main", mainRepo], root);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], mainRepo);
		git(["worktree", "add", "-b", "wt", siblingRepo], mainRepo);
		worktreeRegistered = true;

		await installScript(siblingRepo);

		// Intentionally do NOT write the source binary.

		const result = runScript(siblingRepo);
		assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
		assert.match(result.stderr, /source not found/);
	} finally {
		if (worktreeRegistered) {
			try {
				git(["worktree", "remove", "--force", siblingRepo], mainRepo);
			} catch {
				// On Windows the rm below can race with lingering handles; fall
				// back to a prune so the .git/worktrees/wt entry doesn't leak.
				try {
					git(["worktree", "prune"], mainRepo);
				} catch {
					// best-effort cleanup
				}
			}
		}
		await rm(root, { recursive: true, force: true });
	}
});
