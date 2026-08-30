#!/usr/bin/env node
// Helper for the publish workflow: rename package.json to @bramburn/*
// before npm publish, then restore on exit.
//
// Usage:
//   node scripts/fork-publish-rename.mjs <package-dir> npm publish ...
//
// The first arg is the package directory. All subsequent args run in that
// directory AFTER the package.json name has been swapped. The original
// name is restored in a finally block once the child process exits,
// whether it succeeded or failed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , pkgDir, ...cmd] = process.argv;
if (!pkgDir || cmd.length === 0) {
	console.error("usage: node scripts/fork-publish-rename.mjs <package-dir> <cmd> [args...]");
	process.exit(2);
}

const WORKSPACE_PREFIX = "@earendil-works/";
const FORK_PREFIX = "@bramburn/";
const pkgJsonPath = resolve(pkgDir, "package.json");
const orig = readFileSync(pkgJsonPath, "utf8");
const pkg = JSON.parse(orig);
let exitCode = 0;

if (!pkg.name?.startsWith(WORKSPACE_PREFIX)) {
	console.error(`name "${pkg.name}" is not under ${WORKSPACE_PREFIX}; aborting`);
	process.exit(2);
}

const newName = FORK_PREFIX + pkg.name.slice(WORKSPACE_PREFIX.length);
pkg.name = newName;
writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, "\t")}\n`);
process.stdout.write(`renamed: ${pkgDir} -> ${newName}\n`);

try {
	const result = spawnSync(cmd[0], cmd.slice(1), {
		stdio: "inherit",
		cwd: resolve(pkgDir),
		shell: process.platform === "win32",
	});
	exitCode = result.status ?? 1;
} finally {
	writeFileSync(pkgJsonPath, orig);
	process.stdout.write(`restored: ${pkgDir}\n`);
}

process.exit(exitCode);
