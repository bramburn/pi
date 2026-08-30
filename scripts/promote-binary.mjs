#!/usr/bin/env node
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

import { existsSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

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

// Worktree layout assumed: <main>/.worktrees/<name>/<repo>/...
// The script lives at <worktree>/scripts/promote-binary.mjs, so two parents up
// is the main checkout.
const mainCheckout = resolve(repoRoot, "..", "..");
const src = join(repoRoot, "packages", "coding-agent", "dist", "pi.exe");
const dst = join(mainCheckout, "packages", "coding-agent", "dist", "pi.exe");

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
