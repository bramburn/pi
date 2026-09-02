#!/usr/bin/env node
// Helper for the publish workflow: rename package.json to @bramburn/* before
// npm publish, then restore on exit. Also rewrites every workspace dep under
// the @earendil-works/pi-* scope and the repository.url so the published
// tarball matches the bramburn fork.
//
// Usage:
//   node scripts/fork-publish-rename.mjs <package-dir> <cmd> [args...]
//
// The first arg is the package directory. All subsequent args run in that
// directory AFTER package.json has been rewritten. The original package.json
// is restored in a finally block once the child process exits, whether it
// succeeded or failed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , pkgDir, ...cmd] = process.argv;
if (!pkgDir || cmd.length === 0) {
	console.error("usage: node scripts/fork-publish-rename.mjs <package-dir> <cmd> [args...]");
	process.exit(2);
}

const WORKSPACE_PREFIX = "@earendil-works/pi-";
const FORK_PREFIX = "@bramburn/pi-";
const UPSTREAM_REPO_URL = "git+https://github.com/earendil-works/pi.git";
const FORK_REPO_URL = "git+https://github.com/bramburn/pi.git";

// Dep sections to walk. Order matches how npm itself orders package.json
// fields. Values are rewritten only when the key starts with the workspace
// scope and the value is not a registry alias (`npm:...`).
const DEP_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"optionalDependencies",
];

const pkgJsonPath = resolve(pkgDir, "package.json");
const orig = readFileSync(pkgJsonPath, "utf8");
let pkg;
try {
	pkg = JSON.parse(orig);
} catch (e) {
	console.error(`failed to parse ${pkgJsonPath}: ${e.message}`);
	process.exit(2);
}

if (!pkg.name?.startsWith(WORKSPACE_PREFIX)) {
	console.error(`name "${pkg.name}" is not under ${WORKSPACE_PREFIX}; aborting`);
	process.exit(2);
}

const oldName = pkg.name;
const newName = FORK_PREFIX + oldName.slice(WORKSPACE_PREFIX.length);
pkg.name = newName;

// Rewrite workspace deps in every dep section. Skips registry aliases
// (e.g. `"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0"`) —
// those are deliberate third-party rewrites, not workspace links. Same
// carve-out as scripts/sync-versions.js.
let depRewrites = 0;
for (const section of DEP_SECTIONS) {
	const deps = pkg[section];
	if (!deps || typeof deps !== "object") continue;
	if (Array.isArray(deps)) continue; // peerDependenciesMeta is {pkg: {optional: bool}}
	for (const key of Object.keys(deps)) {
		if (!key.startsWith(WORKSPACE_PREFIX)) continue;
		const value = deps[key];
		if (typeof value === "string" && value.startsWith("npm:")) continue;
		const newKey = FORK_PREFIX + key.slice(WORKSPACE_PREFIX.length);
		if (newKey === key) continue;
		deps[newKey] = value;
		delete deps[key];
		depRewrites += 1;
	}
}

// Rewrite repository.url. Use exact-match to avoid clobbering a future
// "earendil URL is correct" case (e.g. a per-package subpath repo).
let repoRewritten = false;
if (pkg.repository && typeof pkg.repository === "object" && pkg.repository.url === UPSTREAM_REPO_URL) {
	pkg.repository = { ...pkg.repository, url: FORK_REPO_URL };
	repoRewritten = true;
}

writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, "\t")}\n`);
process.stdout.write(
	`renamed: ${pkgDir} -> ${newName} (deps: ${depRewrites} rewrite${depRewrites === 1 ? "" : "s"}, repo: ${repoRewritten ? "rewritten" : "unchanged"})\n`,
);

let exitCode = 0;
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
