#!/usr/bin/env node
// sync-upstream-closed-issues.mjs
//
// Periodic sync: pull user-contributed closed issues from earendil-works/pi
// (the upstream pi-mono repo) that look like code-improvement candidates,
// dedupe against the bramburn/pi fork issue list, and create new fork issues
// so the fork can pick them up independently.
//
// Scope rules (see --help):
//   - Window: last 6 months from run time (override with --since)
//   - Source: earendil-works/pi, state=closed, is:issue
//   - Skip bots / dependabot / weekend auto-closes
//   - Skip pure "new feature" requests (e.g. "Add X provider", "Add Opper")
//     Keep: bug reports, refactors, perf / reliability, regression reports,
//     "improve existing X", error-handling hardening, error-message clarity.
//   - Skip issues touching packages the fork doesn't ship (mom, pods, proxy,
//     web-ui, experimental, openclaw).
//   - Skip issues already represented in bramburn/pi (title or body match).
//
// State is persisted at scripts/.upstream-sync-state.json so re-runs only
// process new closures since the last successful run.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, ".upstream-sync-state.json");

const UPSTREAM = "earendil-works/pi";
const FORK = "bramburn/pi";

// Packages the fork publishes. Issues scoped only to other packages are dropped.
const FORK_PACKAGE_LABELS = new Set([
	"pkg:agent",
	"pkg:ai",
	"pkg:coding-agent",
	"pkg:tui",
]);

// Upstream pkg:* labels the fork ignores (other products in upstream's org).
const IGNORED_UPSTREAM_PACKAGES = new Set([
	"pkg:mom",
	"pkg:pods",
	"pkg:proxy",
	"pkg:web-ui",
]);

// Phrases that mark a ticket as a pure "add new provider/feature" request.
// We strip these before considering the issue for fork work.
const NEW_PROVIDER_PATTERNS = [
	/\badd\b.+\b(as a|as an?)\s+(built-?in\s+)?provider\b/i,
	/\badd\b.+\bprovider\b.*\bintegration\b/i,
	/\bproposal:\s*add\b/i,
	/\bnew\s+provider:\b/i,
	/\badd\s+\w+\s+as\s+a\s+provider\b/i,
	/\b(add|integrate)\b\s+(the\s+)?(opper|aimlapi|command\s*code|kimi|groq|huggingface|baseten|fireworks)\s+(provider|llm)?\b/i,
];

// Phrases that mark a ticket as clearly bug/perf/refactor territory.
// At least one must hit, OR the issue carries an explicit "bug" label.
const IMPROVEMENT_PATTERNS = [
	/\b(bug|crash|panic|freeze|hangs?|leak|overflow|underflow|deadlock|race|regression)\b/i,
	/\b(n\^?2|n\s*squared|quadratic|exponential)\b.*\b(performance|perf|complexity)\b/i,
	/\b(o\([^)]+\))\b.*\bperformance\b/i,
	/\b(perf(ormance)?|throughput|latency|memory)\b.*\b(issue|problem|fix|regression)\b/i,
	/\b(stale|orphaned?|dangling|lost|missing|broken|faulty)\b.*\b(compaction|tool|memory|state|session|checkpoint)\b/i,
	/\b(fix|refactor|harden|robust(ness)?|guard(rails)?|bounds?)\b/i,
	/\b(error|exception|warning|message)\b.*\b(unclear|missing|wrong|misleading|recovery|guidance)\b/i,
	/\b(degenerate|empty|null|undefined|nan|invalid)\b.*\b(stop[_-]?reason|reasoning|tool[_-]?result|checkpoint|summary)\b/i,
	/\b(api|sdk|cli|tui|renderer|terminal|escape|wrap|wraparound|line\s*break|wrapping)\b.*\b(broken|crash|wrong|misrender|off[_-]?by[_-]?one|regression)\b/i,
	/\b(oom|out of memory|stack overflow)\b/i,
	/\b(path|directory|file|fs|disk|read|write)\b.*\b(escape|injection|traversal|symlink)\b/i,
	/\b(xss|injection|deserialization|prototype pollution)\b/i,
	/\b(exit|quit|abort)\b.*\b(when|on)\b.*\b(width|height|pane|terminal|signal|sigint|sigterm)\b/i,
	/\b(scale|clamp|cap|limit|bound)\b.*\b(context|window|reserve|budget|reasoning)\b/i,
	/\b(timeout|retry|cancel|abort)\b.*\b(handler|tool|extension|callback)\b/i,
];

// Auto-close labels from upstream that mean "this issue was never triaged" or
// "rejected after triage". We still keep them if they describe a real bug —
// the fork triages independently.
const UPSTREAM_KEEP_LABELS = new Set(["bug"]);
const UPSTREAM_DROP_LABELS = new Set([
	"close-because-weekend",
	"closed-because-weekend",
	"closed-because-bigrefactor",
	"closed-because-refactor",
	"duplicate",
	"invalid",
	"wontfix",
]);

function log(...args) {
  console.log("[sync-upstream]", ...args);
}

function warn(...args) {
  console.warn("[sync-upstream]", ...args);
}

function gh(args, opts = {}) {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
    return stdout;
  } catch (err) {
    if (err.status !== undefined) {
      throw new Error(
        `gh ${args.join(" ")} exited ${err.status}: ${(err.stderr || err.stdout || err.message).toString().slice(0, 400)}`,
      );
    }
    throw err;
  }
}

function ghJson(args) {
  const out = gh(args);
  if (!out.trim()) return [];
  return JSON.parse(out);
}

// `gh api --paginate` emits one JSON array per page (NDJSON). Concatenate them.
function ghJsonArray(args) {
  const out = gh(args);
  if (!out.trim()) return [];
  let combined = [];
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    combined = combined.concat(JSON.parse(trimmed));
  }
  return combined;
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { lastRunAt: null, syncedUpstreamNumbers: [] };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastRunAt: null, syncedUpstreamNumbers: [] };
  }
}

function saveState(state) {
  if (!existsSync(HERE)) mkdirSync(HERE, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// Months-ago in ISO 8601 with second precision.
function monthsAgoIso(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function titleKey(title) {
  return title
    .toLowerCase()
    .replace(/[`*_~()[\]<>]/g, "")
    .replace(/\b(the|a|an|to|of|for|on|when|with|from|into|and|or)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Pull every closed issue in the window via GraphQL search. GitHub's search
// API caps cursor chains at ~1000 results, so we split the window into small
// monthly chunks and search each chunk separately.
function listUpstreamClosedIssues(sinceIso) {
  const all = [];
  const chunks = chunkWindow(sinceIso, new Date().toISOString(), 30); // 30-day chunks
  log(`split window into ${chunks.length} chunks`);
  const pageSize = 50;
  for (let ci = 0; ci < chunks.length; ci += 1) {
    const { from, to } = chunks[ci];
    log(`  chunk ${ci + 1}/${chunks.length}: ${from} → ${to}`);
    let cursor = null;
    let pages = 0;
    while (true) {
      const cursorArg = cursor ? `, after: "${cursor}"` : "";
      const rangeStr = to ? `created:${from}..${to}` : `created:>=${from}`;
      const query =
        `query { search(` +
        `query: "repo:${UPSTREAM} is:issue is:closed ${rangeStr} sort:created-desc", ` +
        `type: ISSUE, first: ${pageSize}${cursorArg}` +
        `) { ` +
        `issueCount pageInfo { endCursor hasNextPage } ` +
        `nodes { ... on Issue { ` +
        `number title body createdAt closedAt ` +
        `author { login __typename } ` +
        `labels(first: 20) { nodes { name } } ` +
        `} } } }`;
      let resp;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          resp = ghJson(["api", "graphql", "-f", `query=${query}`]);
          break;
        } catch (err) {
          warn(`chunk ${ci + 1} page ${pages + 1} attempt ${attempt} failed: ${err.message.slice(0, 120)}`);
          if (attempt < 3) {
            const wait = 2000 * attempt;
            const start = Date.now();
            while (Date.now() - start < wait) {} // sync sleep
          }
        }
      }
      if (!resp) break;
      const search = resp?.data?.search;
      if (!search) {
        warn(`chunk ${ci + 1}: no search payload (errors=${JSON.stringify(resp?.errors || []).slice(0, 200)})`);
        break;
      }
      for (const node of search.nodes || []) {
        if (!node || !node.number) continue;
        all.push({
          number: node.number,
          title: node.title,
          body: node.body,
          createdAt: node.createdAt,
          closedAt: node.closedAt,
          author: node.author
            ? { login: node.author.login, is_bot: node.author.__typename === "Bot" }
            : null,
          labels: (node.labels?.nodes || []).map((l) => ({ name: l.name })),
        });
      }
      pages += 1;
      if (!search.pageInfo?.hasNextPage) break;
      cursor = search.pageInfo.endCursor;
      if (pages > 50) break; // hard cap per chunk
    }
  }
  // Dedupe by number in case of chunk overlap on boundaries.
  const seen = new Set();
  return all.filter((it) => (seen.has(it.number) ? false : seen.add(it.number)));
}

// Split (from, to] into <=`days`-day chunks. The final chunk has no upper
// bound so we don't miss issues created at the moment the run starts.
function chunkWindow(fromIso, toIso, days) {
  const chunks = [];
  const from = new Date(fromIso);
  const to = new Date(toIso);
  let cursor = new Date(from);
  let isLast = false;
  while (cursor < to) {
    let next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + days);
    if (next >= to) {
      isLast = true;
    } else {
      next = new Date(Math.min(next.getTime(), to.getTime()));
    }
    chunks.push({
      from: cursor.toISOString().replace(/\.\d{3}Z$/, "Z"),
      to: isLast ? null : next.toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    cursor = next;
  }
  return chunks;
}

// Look up full body / labels for a single issue (list output may truncate).
function fetchIssueBody(issueNumber) {
  // The list endpoint already returns full bodies; this fallback only fires
  // when a caller passes a partial object in (e.g. tests).
  try {
    const raw = ghJson(["api", `repos/${UPSTREAM}/issues/${issueNumber}`]);
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body,
      createdAt: raw.created_at,
      closedAt: raw.closed_at,
      author: raw.user ? { login: raw.user.login, is_bot: raw.user.type === "Bot" } : null,
      labels: (raw.labels || []).map((l) => ({ name: l.name })),
    };
  } catch (err) {
    warn(`could not fetch body for upstream #${issueNumber}: ${err.message}`);
    return null;
  }
}

function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
}

function authorLogin(issue) {
  if (!issue.author) return null;
  return issue.author.login || issue.author.name || null;
}

function isBotAuthor(issue) {
  const login = authorLogin(issue) || "";
  if (!login) return true;
  if (issue.author && issue.author.is_bot) return true;
  if (/\[bot\]$/i.test(login)) return true;
  if (/^dependabot$/i.test(login)) return true;
  if (/^renovate/i.test(login)) return true;
  if (/^github-actions$/i.test(login)) return true;
  if (/^earendil-works(\[bot\])?$/i.test(login)) return true;
  return false;
}

function hasOnlyDropLabels(issue) {
  const names = labelNames(issue);
  if (names.length === 0) return false;
  return names.every((n) => UPSTREAM_DROP_LABELS.has(n));
}

function onlyIgnoredPackages(issue) {
  const names = labelNames(issue);
  const pkgLabels = names.filter((n) => n.startsWith("pkg:"));
  if (pkgLabels.length === 0) return false;
  return pkgLabels.every((n) => IGNORED_UPSTREAM_PACKAGES.has(n));
}

function isPureNewFeature(issue) {
  if (labelNames(issue).includes("enhancement") && !labelNames(issue).includes("bug")) {
    // enhancement + no bug label — but still allow if body signals improvement
  }
  for (const re of NEW_PROVIDER_PATTERNS) {
    if (re.test(issue.title || "")) return re;
  }
  return null;
}

function isImprovementCandidate(issue) {
  if (labelNames(issue).includes("bug")) return true;
  if (labelNames(issue).includes("help wanted")) return true;
  const haystack = `${issue.title || ""}\n${issue.body || ""}`;
  for (const re of IMPROVEMENT_PATTERNS) {
    if (re.test(haystack)) return true;
  }
  return false;
}

function mapLabels(issue) {
  const upstream = new Set(labelNames(issue));
  const out = new Set();

  // pkg:* labels: keep only those we ship in the fork.
  for (const name of upstream) {
    if (name.startsWith("pkg:") && FORK_PACKAGE_LABELS.has(name)) {
      out.add(name);
    }
  }

  if (upstream.has("bug")) out.add("bug");
  if (upstream.has("untriaged")) out.add("untriaged");
  if (upstream.has("help wanted")) out.add("help wanted");

  // Heuristic: anything that looks like a regression / perf fix is at least
  // medium priority in the fork backlog.
  if (out.has("bug") || /\b(crash|panic|freeze|leak|regression|perf)\b/i.test(issue.title || "")) {
    out.add("priority:medium");
  }

  return Array.from(out);
}

function buildIssueBody(issue, sourceUrl) {
  const lines = [];
  lines.push(`> Synced from upstream **${UPSTREAM}#${issue.number}** (closed, not implemented there).`);
  lines.push("");
  lines.push(`- **Source:** ${sourceUrl}`);
  lines.push(`- **Upstream author:** @${authorLogin(issue) || "unknown"}`);
  lines.push(`- **Upstream opened:** ${issue.createdAt || "unknown"}`);
  lines.push(`- **Upstream closed:** ${issue.closedAt || "unknown"}`);
  lines.push(`- **Upstream labels:** ${labelNames(issue).join(", ") || "(none)"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Original report");
  lines.push("");
  lines.push((issue.body || "").trim() || "_(no body)_");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Fork notes");
  lines.push("");
  lines.push(
    "Upstream closed this without a fix (auto-close or no-action). The fork can implement it independently.",
  );
  lines.push("");
  lines.push("- [ ] Reproduce / confirm against fork `main`");
  lines.push("- [ ] Decide on scope: minimal patch vs. broader refactor");
  lines.push("- [ ] Implement");
  lines.push("- [ ] Add regression test under `packages/coding-agent/test/suite/regressions/`");
  return lines.join("\n");
}

// Pull all fork issues (open + closed) for dedup. Title dedup is cheap; body
// dedup catches issues that already cite the upstream number.
function listForkIssuesForDedup() {
  const raw = ghJsonArray([
    "api",
    `repos/${FORK}/issues?state=all&per_page=100&sort=created&direction=desc`,
    "--paginate",
  ]);
  // The REST /issues endpoint also returns PRs; the fork's PR set is small,
  // but exclude them anyway so the dedup set is issue-only.
  return (raw || [])
    .filter((it) => !it.pull_request)
    .map((it) => ({
      number: it.number,
      title: it.title,
      body: it.body,
      state: it.state,
    }));
}

function findForkDuplicate(upstreamIssue, forkIssues, forkTitleKeys) {
  const tKey = titleKey(upstreamIssue.title || "");
  if (tKey && forkTitleKeys.has(tKey)) return "title";
  const sourceNum = String(upstreamIssue.number);
  for (const f of forkIssues) {
    const body = (f.body || "") + "\n" + (f.title || "");
    if (body.includes(`#${sourceNum}`) || body.includes(`${UPSTREAM}#${sourceNum}`)) {
      return `body:upstream#${sourceNum}`;
    }
  }
  return null;
}

function createForkIssue(issue, dryRun) {
  const sourceUrl = `https://github.com/${UPSTREAM}/issues/${issue.number}`;
  const title = issue.title || `(upstream #${issue.number})`;
  const body = buildIssueBody(issue, sourceUrl);
  const labels = mapLabels(issue).join(",");
  const args = [
    "issue",
    "create",
    "--repo",
    FORK,
    "--title",
    title,
    "--body",
    body,
  ];
  if (labels) {
    args.push("--label", labels);
  }
  if (dryRun) {
    return { dryRun: true, title, body, labels };
  }
  const out = gh(args);
  // gh prints the new issue URL on stdout.
  const url = out.trim().split(/\r?\n/).pop();
  return { url, title };
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    sinceMonths: 6,
    since: null,
    maxNew: 20,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--since-months") opts.sinceMonths = Number(argv[++i]);
    else if (a === "--max-new") opts.maxNew = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "Usage: node scripts/sync-upstream-closed-issues.mjs [options]",
          "",
          "Options:",
          "  --dry-run           Plan only; do not create fork issues",
          "  --since <iso>       Override window (e.g. 2026-02-26T00:00:00Z)",
          "  --since-months <n>  Window length in months (default 6)",
          "  --max-new <n>       Hard cap on new issues per run (default 20)",
          "  --verbose, -v       Print every skipped reason",
          "  -h, --help          Show this help",
          "",
          "State: scripts/.upstream-sync-state.json",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const state = loadState();
  const since = opts.since || (state.lastRunAt ? state.lastRunAt : monthsAgoIso(opts.sinceMonths));
  log(`window: closed >= ${since}`);
  log(`mode: ${opts.dryRun ? "DRY RUN" : "LIVE"}, max-new: ${opts.maxNew}`);

  const upstream = listUpstreamClosedIssues(since);
  log(`fetched ${upstream.length} closed issues from ${UPSTREAM}`);

  const fork = listForkIssuesForDedup();
  const forkTitleKeys = new Set(
    fork.map((f) => titleKey(f.title || "")).filter((k) => k.length >= 8),
  );
  log(`loaded ${fork.length} fork issues for dedup (${forkTitleKeys.size} unique title keys)`);

  const synced = new Set(state.syncedUpstreamNumbers || []);
  const newlySynced = [];

  let created = 0;
  let skippedBot = 0;
  let skippedDropLabels = 0;
  let skippedIgnoredPkg = 0;
  let skippedNewFeature = 0;
  let skippedNotImprovement = 0;
  let skippedDuplicate = 0;
  let skippedAlreadySynced = 0;
  let skippedCap = 0;

  for (const issue of upstream) {
    if (synced.has(issue.number)) {
      skippedAlreadySynced += 1;
      if (opts.verbose) log(`skip #${issue.number} already synced`);
      continue;
    }
    if (isBotAuthor(issue)) {
      skippedBot += 1;
      if (opts.verbose) log(`skip #${issue.number} bot author`);
      continue;
    }
    if (hasOnlyDropLabels(issue)) {
      skippedDropLabels += 1;
      if (opts.verbose) log(`skip #${issue.number} drop labels only`);
      continue;
    }
    if (onlyIgnoredPackages(issue)) {
      skippedIgnoredPkg += 1;
      if (opts.verbose) log(`skip #${issue.number} only ignored packages`);
      continue;
    }
    if (isPureNewFeature(issue)) {
      skippedNewFeature += 1;
      if (opts.verbose) log(`skip #${issue.number} new feature`);
      continue;
    }
    if (!isImprovementCandidate(issue)) {
      skippedNotImprovement += 1;
      if (opts.verbose) log(`skip #${issue.number} not improvement-shaped`);
      continue;
    }

    // List response already contains full body; only fall back if missing.
    const full = issue.body != null ? issue : (fetchIssueBody(issue.number) || issue);
    const dup = findForkDuplicate(full, fork, forkTitleKeys);
    if (dup) {
      skippedDuplicate += 1;
      log(`dup  upstream#${issue.number} matches fork (${dup})`);
      // Record so we don't re-check it next run.
      newlySynced.push(issue.number);
      continue;
    }

    if (created >= opts.maxNew) {
      // Hit per-run cap. Still record as seen so we don't re-scan it next run.
      skippedCap += 1;
      newlySynced.push(issue.number);
      continue;
    }

    log(`create upstream#${issue.number}: ${full.title}`);
    const result = createForkIssue(full, opts.dryRun);
    created += 1;
    newlySynced.push(issue.number);

    if (!opts.dryRun && result.url) {
      log(`       -> ${result.url}`);
    }
  }

  // Persist state (also records duplicates we saw so we don't re-check them).
  const nextState = {
    lastRunAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    lastRunWindowSince: since,
    syncedUpstreamNumbers: Array.from(
      new Set([...(state.syncedUpstreamNumbers || []), ...newlySynced]),
    ).slice(-5000),
  };
  if (!opts.dryRun) saveState(nextState);

  log("");
  log("=== summary ===");
  log(`window since:           ${since}`);
  log(`upstream closed issues: ${upstream.length}`);
  log(`created:                ${created}${opts.dryRun ? " (dry run)" : ""}`);
  log(`skipped bot:            ${skippedBot}`);
  log(`skipped drop labels:    ${skippedDropLabels}`);
  log(`skipped ignored pkg:    ${skippedIgnoredPkg}`);
  log(`skipped new feature:    ${skippedNewFeature}`);
  log(`skipped not-improvement:${skippedNotImprovement}`);
  log(`skipped duplicate:      ${skippedDuplicate}`);
  log(`skipped already synced: ${skippedAlreadySynced}`);
  log(`skipped (max-new cap):  ${skippedCap}`);
  log(`state file:             ${STATE_FILE}`);
}

main().catch((err) => {
  console.error("[sync-upstream] FAILED:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});