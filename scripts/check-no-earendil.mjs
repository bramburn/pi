import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const args = new Set(process.argv.slice(2));
const listMode = args.has("--list");
const jsonMode = args.has("--json");

// Directories excluded from traversal (Categories F, G, H in specs/batch/rebrand-sweep-checklist.md).
// Entries are matched against both the bare directory name and the repo-relative path, so generated
// output directories that only exist at one location (website/build, website/.docusaurus — both
// gitignored Docusaurus output) can be excluded without skipping same-named source directories.
const ignoredDirectories = new Set([
	".git",
	".worktrees",
	"worktrees",
	".claude",
	"dist",
	"node_modules",
	".artifacts",
	"types",
	"lab",
	"checkpoint-evidence",
	"scratch",
	"research",
	"install-lock",
	"website/build",
	"website/.docusaurus",
]);

// Specific files excluded (lockfiles, generated artifacts, immutable historical specs/changelogs)
const ignoredFiles = new Set([
	"package-lock.json",
	"bun.lock",
	"packages/coding-agent/npm-shrinkwrap.json",
	"packages/ai/src/models.generated.ts",
	"scripts/check-no-earendil.mjs",
	"scripts/qi-brand-allowlist.json",
	"specs/batch/batch-context.md",
	"specs/batch/rebrand-sweep-checklist.md",
]);

const scannedExtensions = new Set([
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".json",
	".md",
	".mdx",
	".yml",
	".yaml",
	".sh",
	".ps1",
	".cmd",
	".feature",
]);

const allowlistPath = "scripts/qi-brand-allowlist.json";
const allowlist = existsSync(allowlistPath)
	? JSON.parse(readFileSync(allowlistPath, "utf8"))
	: { ignoreFiles: [], ignoreLinePatterns: [] };
const allowlistFiles = new Set(allowlist.ignoreFiles ?? []);
const allowlistRegexes = (allowlist.ignoreLinePatterns ?? []).map((p) => new RegExp(p));

const rules = [
	{
		id: "earendil-ref",
		description: "Upstream earendil reference",
		pattern: /earendil(?:-works)?/i,
	},
	{
		id: "pi-package-scope",
		description: "Legacy pi package scope (@earendil-works/pi-* or @bramburn/pi-*)",
		pattern: /@(?:earendil-works|bramburn)\/pi-[a-z0-9-]+/,
	},
	{
		id: "pi-dev-endpoint",
		description: "Upstream pi.dev endpoint or URL",
		pattern: /\bpi\.dev\b/,
	},
	{
		id: "pi-env-var",
		description: "Legacy PI_* environment variable",
		pattern: /\bPI_(?:CODING_AGENT_DIR|PACKAGE_DIR|MODEL|PROVIDER|SESSION_FILE|SESSION_ID|REASONING_LEVEL|TELEMETRY|OFFLINE|SKIP_VERSION_CHECK|CACHE_RETENTION|HARDWARE_CURSOR|HYPERLINKS|IMAGE_PROTOCOL|SHARE_VIEWER_URL|TRUE_COLOR|TUI_ESC_TIMEOUT|AI_DEBUG|SUBAGENT_[A-Z0-9_]+|BUNDLED_NODE|CLEAR_ON_SHRINK|INSTALLER_API_BASE|STARTUP_BENCHMARK|TIMING|ENVIRONMENT|ALLOW_LOCKFILE_CHANGE)\b/,
	},
	{
		id: "pi-config-dir",
		description: "Legacy ~/.pi or .pi/ directory path",
		pattern: /(?:~\/\.pi\b|['"`\s(]\.pi\/)/,
	},
	{
		id: "pi-brand-token",
		description: "Legacy pi brand identifier (pi-monorepo, pi-coding-agent, piConfig, pi.share, pi-session, pi-package)",
		pattern: /\b(?:pi-monorepo|pi-coding-agent|piConfig|pi\.share|pi-session|pi-package)\b/,
	},
];

function shouldSkipFile(relPath) {
	if (ignoredFiles.has(relPath) || allowlistFiles.has(relPath)) return true;
	if (relPath.startsWith("specs/.history/")) return true;
	if (relPath.endsWith("/CHANGELOG.md") || relPath === "CHANGELOG.md") return true;
	const ext = extname(relPath);
	return !scannedExtensions.has(ext);
}

const candidateFiles = [];

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name) && !ignoredDirectories.has(relPath)) {
				walk(relPath);
			}
			continue;
		}
		if (entry.isFile() && !shouldSkipFile(relPath)) {
			candidateFiles.push(relPath);
		}
	}
}

walk(".");

const findings = [];

for (const file of candidateFiles.sort()) {
	const content = readFileSync(file, "utf8");
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (allowlistRegexes.some((rx) => rx.test(`${file}:${line}`))) continue;
		for (const rule of rules) {
			const match = line.match(rule.pattern);
			if (match) {
				findings.push({
					file,
					line: i + 1,
					rule: rule.id,
					match: match[0],
					snippet: line.trim().slice(0, 140),
				});
			}
		}
	}
}

if (jsonMode) {
	console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
} else if (listMode) {
	for (const f of findings) {
		console.log(`${f.file}:${f.line} [${f.rule}] ${f.match}`);
	}
} else if (findings.length > 0) {
	console.error(`Found ${findings.length} prohibited pi/earendil brand occurrence(s):`);
	for (const f of findings.slice(0, 100)) {
		console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.match} -> ${f.snippet}`);
	}
	if (findings.length > 100) {
		console.error(` ... and ${findings.length - 100} more (run with --list or --json for full output).`);
	}
	process.exit(1);
}

if (findings.length > 0) {
	process.exit(1);
}
