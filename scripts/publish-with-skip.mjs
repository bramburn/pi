#!/usr/bin/env node
// Run `npm publish` (or any command) and translate the failure modes that
// we expect during a fork release into a clear, actionable log line:
//
// - HTTP 403 "You cannot publish over the previously published versions" —
//   this version is already on npm (idempotent re-run), skip silently.
// - ENEEDAUTH — npm trusted publishing OIDC didn't match. The package's
//   trusted-publisher entry on npmjs.com is missing or doesn't match the
//   current workflow filename / environment. Print a loud hint and exit
//   non-zero so the workflow step surfaces as failed rather than silently
//   "skipped".
// - anything else — exit non-zero so the step surfaces as failed.
//
// Usage:
//   node scripts/publish-with-skip.mjs <package-dir> [cmd args...]
//
// The first arg is the package directory (used only for logging). All
// remaining args run as a child process. Exit codes:
//   0 - publish succeeded OR version is already on npm
//   1 - publish failed for a reason that needs human attention

import { spawnSync } from "node:child_process";

const [, , pkgDir, ...cmd] = process.argv;
if (!pkgDir || cmd.length === 0) {
	console.error("usage: node scripts/publish-with-skip.mjs <package-dir> <cmd> [args...]");
	process.exit(2);
}

const result = spawnSync(cmd[0], cmd.slice(1), {
	// Stream stdout/stderr to the caller (GitHub Actions log) but also
	// capture stderr so we can grep for known failure modes below.
	// Without piping stderr, the ENEEDAUTH / 403 detection below would
	// run against an empty buffer.
	stdio: ["inherit", "inherit", "pipe"],
	cwd: pkgDir,
	shell: process.platform === "win32",
});

if (result.status === 0) {
	process.exit(0);
}

// Capture stderr so we can grep it for known error codes. Stdio was
// "inherit" so it has already been printed; that is intentional — we
// still want the raw output in the run log.
const stderr = (result.stderr ?? "").toString();
const stdout = (result.stdout ?? "").toString();
const combined = `${stderr}\n${stdout}`;

if (combined.includes("You cannot publish over the previously published versions")) {
	console.error(`[publish-with-skip] ${pkgDir}: version already on npm, treating as success (idempotent).`);
	process.exit(0);
}

if (combined.includes("ENEEDAUTH") || /code E40[2345]\b/.test(combined) || /code ENOTFOUND\b/.test(combined)) {
	console.error(
		`[publish-with-skip] ${pkgDir}: ENEEDAUTH / registry auth failure.\n` +
			`  This usually means the npm trusted publisher entry for this package on npmjs.com is\n` +
			`  missing or doesn't match this workflow (filename: publish.yml, environment:\n` +
			`  npm-publish, repo: bramburn/pi). Configure it under the package's npmjs.com\n` +
			`  Settings -> Trusted Publishers and re-run the workflow.`,
	);
	process.exit(result.status ?? 1);
}

process.exit(result.status ?? 1);
