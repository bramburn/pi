#!/usr/bin/env bun
// Promote the freshly built `dist/pi.exe` from a worktree to the main checkout.
//
// Why: the `pi-bun.cmd` wrapper at C:\Users\bramburn\.pi\agent\bin\pi-bun.cmd
// points at the main checkout's packages\coding-agent\dist\pi.exe. A
// `bun run --cwd packages/coding-agent build:binary` invoked inside a worktree
// only produces that worktree's dist\pi.exe; the user keeps running the stale
// main-checkout binary until something copies the artifact over.
//
// Usage: run from packages/coding-agent/:
//   npm run build:promote
//
// Behavior:
//   - In a worktree (`.git` is a file, not a directory): copies the worktree's
//     packages/coding-agent/dist\pi.exe to the main checkout's same path.
//   - In the main checkout (`.git` is a directory): no-op with a clear message.
//   - Exits 2 if the source binary is missing (so CI / pre-commit hooks fail
//     loudly instead of silently copying nothing).
//   - The main checkout is found via `git rev-parse --git-common-dir` rather
//     than by walking parent directories, so it works regardless of how the
//     worktree is laid out on disk.

import { execFileSync } from "node:child_process";
import { existsSync, statSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BINARY_NAME = process.platform === "win32" ? "pi.exe" : "pi";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function findMainCheckout(repoRoot) {
	let commonDir;
	try {
		commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		if (error.code === "ENOENT") {
			console.error("[promote-binary] git not found on PATH");
		} else {
			console.error(`[promote-binary] git rev-parse failed: ${error.message}`);
		}
		return null;
	}
	const resolvedCommon = isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir);
	const main = resolve(resolvedCommon, "..");
	if (!existsSync(main)) {
		return null;
	}
	return main;
}

// Detect worktree: in a worktree, .git is a file pointing at
// $GIT_DIR/worktrees/<name>. In a main checkout, .git is a directory.
const gitPath = join(repoRoot, ".git");
let isWorktree = false;
try {
	const s = statSync(gitPath);
	isWorktree = !s.isDirectory();
} catch {
	// .git missing entirely -- treat as not-a-worktree and let the caller deal
	// with the source-not-found case below.
}

if (!isWorktree) {
	console.log(`[promote-binary] ${repoRoot} is the main checkout; nothing to promote.`);
	process.exit(0);
}

// Resolve main checkout via git, not by walking parents — this works for
// any worktree layout (sibling worktrees, .worktrees/ under main, etc.).
const mainCheckout = findMainCheckout(repoRoot);
if (!mainCheckout) {
	console.error(`[promote-binary] failed to resolve main checkout from ${repoRoot}`);
	process.exit(1);
}
const src = join(repoRoot, "packages", "coding-agent", "dist", BINARY_NAME);
const dst = join(mainCheckout, "packages", "coding-agent", "dist", BINARY_NAME);

if (!existsSync(src)) {
	console.error(`[promote-binary] source not found: ${src}`);
	console.error(`[promote-binary] hint: run \`bun run --cwd packages/coding-agent build:binary\` first.`);
	process.exit(2);
}

if (src === dst) {
	console.log(`[promote-binary] src and dst resolve to the same path; nothing to do.`);
	process.exit(0);
}

const srcStat = statSync(src);
copyFileSync(src, dst);
const dstStat = statSync(dst);

console.log(`[promote-binary] promoted ${src} (${srcStat.size} B)`);
console.log(`[promote-binary]          -> ${dst} (${dstStat.size} B)`);

if (srcStat.size !== dstStat.size) {
	console.error(`[promote-binary] size mismatch after copy!`);
	process.exit(1);
}

console.log(`[promote-binary] done.`);
