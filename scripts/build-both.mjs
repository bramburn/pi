#!/usr/bin/env node
/**
 * scripts/build-both.mjs
 *
 * Build the pi Node.js and Bun targets in one shot, with per-target
 * status reporting.
 *
 * - Detects `node` and `bun` on PATH (with version + resolved path).
 * - Builds the Node.js target via `npm run build` (when node is available
 *   and the target is not skipped).
 * - Builds the Bun binary target via
 *   `bun run --cwd packages/coding-agent build:binary` (when bun is
 *   available and the target is not skipped).
 * - Reports each target as BUILT (with artifact path), SKIPPED (with
 *   reason), or FAILED (with reason).
 * - Verifies the expected artifact exists before reporting BUILT.
 *
 * Exit codes:
 *   0  all enabled builds succeeded
 *   1  one or more enabled builds failed
 *   2  invalid arguments
 *   3  script is not located inside a pi-monorepo checkout
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const nodeArtifact = join(codingAgentDir, "dist", "cli.js");
const bunBinary = process.platform === "win32"
	? join(codingAgentDir, "dist", "pi.exe")
	: join(codingAgentDir, "dist", "pi");
const isWindows = process.platform === "win32";
const useShell = isWindows;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
	printHelp();
	process.exit(0);
}

verifyRepoRoot();

const runtimes = detectRuntimes();
printRuntimeSection(runtimes);

const results = {
	node: runNodeTarget(runtimes),
	bun: runBunTarget(runtimes),
};

printSummary(runtimes, results);

const failed = Object.values(results).some((r) => r.status === "failed");
process.exit(failed ? 1 : 0);

function parseArgs(argv) {
	const opts = {
		help: false,
		nodeOnly: false,
		bunOnly: false,
		skipNode: false,
		skipBun: false,
		clean: false,
		quiet: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "-h":
			case "--help":
				opts.help = true;
				break;
			case "--node-only":
				opts.nodeOnly = true;
				opts.skipBun = true;
				break;
			case "--bun-only":
				opts.bunOnly = true;
				opts.skipNode = true;
				break;
			case "--skip-node":
				opts.skipNode = true;
				break;
			case "--skip-bun":
				opts.skipBun = true;
				break;
			case "--clean":
				opts.clean = true;
				break;
			case "--quiet":
				opts.quiet = true;
				break;
			default:
				console.error(`build-both: unknown option: ${arg}`);
				process.exit(2);
		}
	}
	return opts;
}

function printHelp() {
	console.log(`Usage: node scripts/build-both.mjs [options]

Builds the pi Node.js and Bun targets. Detects which runtimes are
present on PATH, builds each target that is both enabled and
supported, and reports the result with a reason for any skip or
failure.

Targets:
  Node  npm run build                         -> dist/ in every workspace package
                                                -> packages/coding-agent/dist/cli.js
  Bun   bun run --cwd packages/coding-agent   -> packages/coding-agent/dist/pi(.exe)
       build:binary

Options:
  --node-only     Build only the Node target
  --bun-only      Build only the Bun target
  --skip-node     Skip the Node build
  --skip-bun      Skip the Bun build
  --clean         Run 'npm run clean --workspaces' before building
  --quiet         Suppress per-step command lines
  -h, --help      Show this help

Exit codes:
  0  all enabled builds succeeded
  1  one or more enabled builds failed
  2  invalid arguments
  3  script is not inside a pi-monorepo checkout

Examples:
  node scripts/build-both.mjs                build both, skip whichever runtime is missing
  node scripts/build-both.mjs --node-only    build only the Node target
  node scripts/build-both.mjs --bun-only     build only the Bun binary target
  node scripts/build-both.mjs --clean        clean dist/ first, then build both
`);
}

function log(message) {
	if (options.quiet) return;
	console.log(`[build-both] ${message}`);
}

function logSection(title) {
	if (options.quiet) return;
	const bar = "-".repeat(Math.max(8, title.length + 2));
	console.log("");
	console.log(`[build-both] ${title}`);
	console.log(`[build-both] ${bar}`);
}

function detectRuntime(bin) {
	const result = spawnSync(bin, ["--version"], {
		encoding: "utf8",
		shell: useShell,
		windowsHide: true,
	});
	if (result.status !== 0) return { available: false };
	const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const version = stdout.split(/\r?\n/)[0]?.trim() || "(unknown version)";
	const whichCmd = isWindows ? "where.exe" : "which";
	const whichResult = spawnSync(whichCmd, [bin], {
		encoding: "utf8",
		shell: useShell,
		windowsHide: true,
	});
	const path = (whichResult.stdout ?? "").trim().split(/\r?\n/)[0] || "";
	return { available: true, version, path };
}

function runCommand(label, command, args) {
	log(`$ ${label}: ${command} ${args.map(quote).join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: "inherit",
		shell: useShell,
		windowsHide: true,
	});
	return result.status ?? 1;
}

function quote(value) {
	if (/\s/.test(value)) {
		return isWindows ? `"${value}"` : `'${value}'`;
	}
	return value;
}

function verifyRepoRoot() {
	const pkgPath = join(repoRoot, "package.json");
	if (!existsSync(pkgPath)) {
		console.error(`build-both: cannot find ${pkgPath}; the script must live inside a pi-monorepo checkout.`);
		process.exit(3);
	}
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	if (pkg.name !== "pi-monorepo") {
		console.error(`build-both: ${pkgPath} is not a pi-monorepo (name: ${pkg.name}).`);
		process.exit(3);
	}
}

function detectRuntimes() {
	return {
		node: detectRuntime("node"),
		bun: detectRuntime("bun"),
	};
}

function printRuntimeSection(runtimes) {
	const { node, bun } = runtimes;
	logSection("Runtime detection");
	if (node.available) {
		log(`node  ${node.version}  ${node.path || "(path not resolved)"}`);
	} else {
		log("node  not found on PATH");
	}
	if (bun.available) {
		log(`bun   ${bun.version}  ${bun.path || "(path not resolved)"}`);
	} else {
		log("bun   not found on PATH  (install from https://bun.sh to enable the Bun target)");
	}
}

function runNodeTarget(runtimes) {
	const { node } = runtimes;
	if (options.skipNode) {
		logSection("Node target");
		log("Node  SKIPPED  --skip-node");
		return { status: "skipped", reason: "--skip-node" };
	}
	if (!node.available) {
		logSection("Node target");
		log("Node  SKIPPED  node not found on PATH");
		return { status: "skipped", reason: "node not found on PATH" };
	}

	logSection(`Node target (${node.version})`);
	if (options.clean) {
		const status = runCommand("node-clean", "npm", ["run", "clean", "--workspaces"]);
		if (status !== 0) return { status: "failed", reason: "npm run clean failed" };
	}
	const status = runCommand("node-build", "npm", ["run", "build"]);
	if (status !== 0) return { status: "failed", reason: "npm run build failed" };
	if (!existsSync(nodeArtifact)) {
		return { status: "failed", reason: `expected artifact missing after build: ${nodeArtifact}` };
	}
	return { status: "ok", reason: null };
}

function runBunTarget(runtimes) {
	const { bun } = runtimes;
	if (options.skipBun) {
		logSection("Bun target");
		log("Bun   SKIPPED  --skip-bun");
		return { status: "skipped", reason: "--skip-bun" };
	}
	if (!bun.available) {
		logSection("Bun target");
		log("Bun   SKIPPED  bun not found on PATH  (install from https://bun.sh to enable the Bun target)");
		return { status: "skipped", reason: "bun not found on PATH" };
	}

	logSection(`Bun target (${bun.version})`);
	if (options.clean) {
		const status = runCommand("bun-clean", "bun", ["run", "clean", "--workspaces"]);
		if (status !== 0) return { status: "failed", reason: "bun run clean failed" };
	}
	const status = runCommand(
		"bun-build",
		"bun",
		["run", "--cwd", "packages/coding-agent", "build:binary"],
	);
	if (status !== 0) return { status: "failed", reason: "build:binary failed" };
	if (!existsSync(bunBinary)) {
		return { status: "failed", reason: `expected binary missing after build: ${bunBinary}` };
	}
	return { status: "ok", reason: null };
}

function printSummary(runtimes, results) {
	const { node, bun } = runtimes;

	logSection("Summary");
	if (node.available) log(`node  ${node.version}  ${node.path || ""}`.trimEnd());
	else log("node  not found on PATH");
	if (bun.available) log(`bun   ${bun.version}  ${bun.path || ""}`.trimEnd());
	else log("bun   not found on PATH");
	console.log("");

	const labels = {
		node: "Node  (npm run build)",
		bun: "Bun   (build:binary)",
	};
	const artifacts = { node: nodeArtifact, bun: bunBinary };

	for (const [key, result] of Object.entries(results)) {
		const label = labels[key].padEnd(22);
		if (result.status === "ok") {
			log(`${label} BUILT    -> ${artifacts[key]}`);
		} else if (result.status === "skipped") {
			log(`${label} SKIPPED  (${result.reason})`);
		} else {
			log(`${label} FAILED   (${result.reason})`);
		}
	}

	const counts = { ok: 0, skipped: 0, failed: 0 };
	for (const r of Object.values(results)) {
		if (r.status === "ok") counts.ok += 1;
		else if (r.status === "skipped") counts.skipped += 1;
		else if (r.status === "failed") counts.failed += 1;
	}
	log(`${counts.ok} built, ${counts.skipped} skipped, ${counts.failed} failed.`);
}
