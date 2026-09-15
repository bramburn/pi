#!/usr/bin/env bun
/**
 * Bump the version field of every workspace package.json.
 *
 * Replaces `npm version <target> --workspaces --no-git-tag-version
 * --no-workspaces-update` which npm CLI supports but bun's package manager
 * does not (bun has no `--workspaces` flag for `bun pm pkg version`).
 *
 * Strategy: walk every package directory via findPackageDirectories, then for
 * each one invoke `npm.cmd version <target> --no-git-tag-version
 * --no-workspaces-update` with the per-workspace cwd. We keep the underlying
 * version bump on npm CLI because npm is the only tool that owns the
 * package-lock.json regeneration semantics required by downstream
 * consumers; bun install writes bun.lock, not package-lock.json.
 *
 * Usage:
 *   bun scripts/bump-version.mjs patch   # bump patch field
 *   bun scripts/bump-version.mjs minor
 *   bun scripts/bump-version.mjs major
 *   bun scripts/bump-version.mjs 0.84.6  # explicit version
 *
 * Note: explicit versions (x.y.z) used as part of a release should go
 * through `scripts/release.mjs`, which additionally regenerates changelogs,
 * tags the commit, and pushes. This script only bumps the version field
 * across workspace package.json files.
 */

import { spawnSync } from "node:child_process";
import { findPackageDirectories } from "./package-workspaces.mjs";

const target = process.argv[2];
if (!target || (target !== "patch" && target !== "minor" && target !== "major" && !/^\d+\.\d+\.\d+$/.test(target))) {
	console.error("Usage: bun scripts/bump-version.mjs <patch|minor|major|x.y.z>");
	process.exit(2);
}

const dirs = findPackageDirectories("packages");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["version", target, "--no-git-tag-version", "--no-workspaces-update"];

let updated = 0;
for (const dir of dirs) {
	const result = spawnSync(npmCmd, args, { cwd: dir, shell: false, stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`bump-version: ${dir} exited with status ${result.status}`);
		if (result.error) {
			console.error(`bump-version: ${result.error.message}`);
		}
		process.exit(result.status ?? 1);
	}
	console.log(`${dir}: bumped to ${target}`);
	updated += 1;
}

console.log(`bump-version: ${updated} workspace(s) bumped to ${target}.`);
