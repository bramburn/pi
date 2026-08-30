#!/usr/bin/env node
// sync-upstream-scheduler.mjs
//
// Cross-platform scheduler installer for the upstream-closed-issue sync.
//
//   node scripts/sync-upstream-scheduler.mjs install   # register
//   node scripts/sync-upstream-scheduler.mjs uninstall # remove
//   node scripts/sync-upstream-scheduler.mjs status    # show current
//
// Schedule: every Monday 09:00 local time. The sync itself is incremental
// (uses scripts/.upstream-sync-state.json) so the cadence is harmless if
// the user also runs it ad-hoc.
//
// macOS / Linux: writes a user crontab entry.
// Windows:       registers a Task Scheduler task under \Pi\UpstreamSync.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const SYNC_SCRIPT = join(HERE, "sync-upstream-closed-issues.mjs");
const NODE = process.execPath;
const TASK_NAME = "\\Pi\\UpstreamSync";
const CRON_TAG = "# pi:upstream-sync";

function log(...args) {
  console.log("[sync-scheduler]", ...args);
}

function shellOut(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
  } catch (err) {
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

function isWindows() {
  return process.platform === "win32";
}

function isMac() {
  return process.platform === "darwin";
}

// --- Windows (Task Scheduler) ------------------------------------------------

function windowsInstall() {
  // schtasks treats `\Pi\UpstreamSync` as "folder Pi, task UpstreamSync",
  // creating it at root. We keep the same name on query/delete for symmetry.
  const taskName = TASK_NAME;
  const action = `cmd.exe /c cd /d "${REPO_ROOT}" && "${NODE}" "${SYNC_SCRIPT}" --max-new 20`;
  // Use schtasks for the install (no admin needed for /tn scoped under
  // \Pi\, and no password prompt).
  const args = [
    "/Create",
    "/TN",
    taskName,
    "/TR",
    action,
    "/SC",
    "WEEKLY",
    "/D",
    "MON",
    "/ST",
    "09:00",
    "/F", // force overwrite
    "/RL",
    "HIGHEST",
  ];
  shellOut("schtasks", args);
  log(`installed ${taskName} (weekly Monday 09:00)`);
}

function windowsUninstall() {
  try {
    shellOut("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    log(`removed ${TASK_NAME}`);
  } catch (err) {
    if (err.status === 1) {
      log(`${TASK_NAME} was not installed`);
    } else {
      throw err;
    }
  }
}

function windowsStatus() {
  try {
    const out = shellOut("schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
    const line = (k) => out.split(/\r?\n/).find((l) => l.startsWith(k));
    log(`status:`);
    log(`  TaskName:    ${line("TaskName:")?.split(":").slice(1).join(":").trim() || TASK_NAME}`);
    log(`  Status:      ${line("Status:")?.split(":").slice(1).join(":").trim() || "?"}`);
    log(`  NextRun:     ${line("Next Run Time:")?.split(":").slice(1).join(":").trim() || "?"}`);
    log(`  Schedule:    ${line("Schedule Type:")?.split(":").slice(1).join(":").trim() || "?"}`);
    log(`  LastRun:     ${line("Last Run Time:")?.split(":").slice(1).join(":").trim() || "never"}`);
    log(`  LastResult:  ${line("Last Run Result:")?.split(":").slice(1).join(":").trim() || "?"}`);
  } catch (err) {
    if (err.status === 1) log(`${TASK_NAME} is not installed`);
    else throw err;
  }
}

// --- Unix (cron) -------------------------------------------------------------

function unixCrontab() {
  // Returns the current user's crontab (empty string if none).
  try {
    return shellOut("crontab", ["-l"]);
  } catch (err) {
    if (err.status === 1) return "";
    throw err;
  }
}

function unixWriteCrontab(content) {
  const tmp = join(os.tmpdir(), `pi-crontab-${Date.now()}.txt`);
  // Node's writeFileSync avoids UTF-8 BOM traps from PowerShell/cmd.
  writeFileSync(tmp, content, "utf8");
  shellOut("crontab", [tmp]);
}

function unixInstall() {
  const entry = `0 9 * * 1 cd "${REPO_ROOT}" && "${NODE}" "${SYNC_SCRIPT}" --max-new 20 ${CRON_TAG}`;
  const cur = unixCrontab();
  const filtered = cur
    .split(/\r?\n/)
    .filter((l) => !l.includes(CRON_TAG))
    .join("\n");
  const next = `${filtered}${filtered.endsWith("\n") || filtered === "" ? "" : "\n"}${entry}\n`;
  unixWriteCrontab(next);
  log(`installed crontab entry (weekly Monday 09:00)`);
  log(`  entry: ${entry}`);
}

function unixUninstall() {
  const cur = unixCrontab();
  const filtered = cur
    .split(/\r?\n/)
    .filter((l) => !l.includes(CRON_TAG))
    .join("\n");
  if (filtered === cur) {
    log("no crontab entry found");
    return;
  }
  unixWriteCrontab(filtered);
  log("removed crontab entry");
}

function unixStatus() {
  const cur = unixCrontab();
  const line = cur.split(/\r?\n/).find((l) => l.includes(CRON_TAG));
  if (line) log(`crontab entry: ${line}`);
  else log("no crontab entry");
}

// --- main --------------------------------------------------------------------

function main() {
  const cmd = process.argv[2] || "install";
  if (!existsSync(SYNC_SCRIPT)) {
    console.error(`[sync-scheduler] cannot find ${SYNC_SCRIPT}`);
    process.exit(2);
  }

  if (isWindows()) {
    if (cmd === "install") windowsInstall();
    else if (cmd === "uninstall") windowsUninstall();
    else if (cmd === "status") windowsStatus();
    else usage();
  } else if (isMac() || process.platform === "linux") {
    // macOS supports cron but launchd is preferred; we still use cron
    // because the script only needs to run weekly.
    if (cmd === "install") unixInstall();
    else if (cmd === "uninstall") unixUninstall();
    else if (cmd === "status") unixStatus();
    else usage();
  } else {
    console.error(`[sync-scheduler] unsupported platform: ${process.platform}`);
    process.exit(2);
  }
}

function usage() {
  console.error("Usage: node scripts/sync-upstream-scheduler.mjs <install|uninstall|status>");
  process.exit(2);
}

try {
  main();
} catch (err) {
  console.error("[sync-scheduler] FAILED:", err.message);
  process.exit(1);
}