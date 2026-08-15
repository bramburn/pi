#!/usr/bin/env node
// Helper for the publish workflow: rename package.json to @bramburn/*
// before npm publish, then restore on exit. Run with: node <package-dir>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgDir = process.argv[2];
const pkgJsonPath = resolve(pkgDir, "package.json");
const orig = readFileSync(pkgJsonPath, "utf8");
const pkg = JSON.parse(orig);
const WORKSPACE_PREFIX = "@earendil-works/";
const FORK_PREFIX = "@bramburn/";

if (!pkg.name?.startsWith(WORKSPACE_PREFIX)) {
	console.error(`name "${pkg.name}" is not under ${WORKSPACE_PREFIX}; nothing to do`);
	process.exit(0);
}

const newName = FORK_PREFIX + pkg.name.slice(WORKSPACE_PREFIX.length);
pkg.name = newName;
writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, "\t")}\n`);
process.stdout.write(`renamed: ${pkgDir} -> ${newName}\n`);

process.on("exit", () => {
	try {
		writeFileSync(pkgJsonPath, orig);
		process.stdout.write(`restored: ${pkgDir}\n`);
	} catch (e) {
		process.stderr.write(`FAILED to restore ${pkgJsonPath}: ${e.message}\n`);
		process.exit(1);
	}
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
