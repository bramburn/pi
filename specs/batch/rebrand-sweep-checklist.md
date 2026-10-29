# qi Rebrand Sweep Checklist & Execution Strategy

Post-critical-path sweep plan for the remaining ~7,550 `earendil` (~4,604) and word-boundary `pi` (~2,953) occurrences across the repository.

**Precondition:** Critical-path tasks (`fix-17` / `fix-18`) have already landed:
- Workspace package identity (`@bramburn/qi-*`, root `qi-monorepo` in `package.json:2`).
- Core config constants (`packages/coding-agent/src/config.ts:509-540`: `APP_NAME = "qi"`, `CONFIG_DIR_NAME = ".qi"`, `ENV_AGENT_DIR`, `getAgentDir()`).
- CLI entry points, binary name (`packages/coding-agent/package.json:11`), startup banner (`packages/coding-agent/src/cli/startup-ui.ts:33-34`), `--version` output (`packages/coding-agent/src/main.ts:832`).
- Environment variables (`PI_*` → `QI_*`) and upstream endpoint severance (`pi.dev/*`).

---

## 1. Area Inventory & Batch Execution Plan

| Batch | Area / Glob | Target Patterns | Exact Grep Command | Risk | Verification Command | Re-run Tests? |
|---|---|---|---|---|---|---|
| **A1** | `packages/*/src/**` (imports & package refs) | `@earendil-works/pi-*` | `grep -rnE '@earendil-works/pi-' packages/*/src/ packages/session-backends/*/src/` | **HIGH** | `bun run check && ./test.sh` | **Yes** (full `./test.sh`) |
| **A2** | `packages/*/src/**` (runtime strings, comments, types, error messages, extension loader aliases) | `\bpi\b`, `.pi/`, `pi-session`, `pi.share`, `pi-package` | `grep -rnE '(\bpi\b|\.pi/|pi-session|pi\.share|pi-package|PI_[A-Z0-9_]+)' packages/*/src/ packages/session-backends/*/src/` | **HIGH** | `bun run check && ./test.sh` | **Yes** (per-package vitest + `packages/tui` `node --test`) |
| **A3** | `packages/*/test/**` & `packages/*/examples/**` | `@earendil-works/pi-*`, `\bpi\b`, `.pi/`, `PI_*` | `grep -rnE '(@earendil-works/pi-|\bpi\b|\.pi/|PI_[A-Z0-9_]+)' packages/*/test/ packages/coding-agent/examples/` | **MEDIUM** | `./test.sh` | **Yes** (mandatory; check test count `N > 0`) |
| **B** | `packages/coding-agent/docs/**` & `docs/**` & root `README.md`, `AGENTS.md`, `CONTRIBUTING.md` | `earendil`, `pi.dev`, `PI_*`, `~/.pi`, `.pi/`, `\bpi\b` | `grep -rnE '(earendil|pi\.dev|PI_[A-Z0-9_]+|~/.pi|\.pi/|\bpi\b)' packages/coding-agent/docs/ docs/ README.md AGENTS.md` | **LOW** | `node scripts/check-no-earendil.mjs` | No (docs only) |
| **C** | `website/**` (Docusaurus config, sidebars, docs, landing page `website/src/pages/index.tsx:116`) | `earendil`, `@bramburn/pi-`, `pi.dev`, `/pi/`, `\bpi\b` | `grep -rnE '(earendil|@bramburn/pi-|pi\.dev|\bpi\b)' website/docs/ website/src/ website/docusaurus.config.ts website/sidebars.ts` | **LOW** | `bun run --cwd website build` (`onBrokenLinks: 'throw'`) | No (website build verifies links) |
| **D** | `scripts/**` (build, shrinkwrap, install-lock, release, check scripts; `scripts/check-pinned-deps.mjs:27`) | `@earendil-works/pi-`, `pi-monorepo`, `PI_ALLOW_LOCKFILE_CHANGE`, `pi.exe` | `grep -rnE '(earendil|@bramburn/pi-|pi-monorepo|PI_[A-Z0-9_]+|\bpi\b)' scripts/` | **HIGH** | `bun run check && bun test scripts/*.test.mjs` | **Yes** (`bun run test:scripts`) |
| **E** | `.github/**` (workflows, actions, issue templates, `.github/workflows/publish.yml`) | `earendil`, `@bramburn/pi-`, `PI_*`, `pi-mono`, `\bpi\b` | `grep -rnE '(earendil|@bramburn/pi-|PI_[A-Z0-9_]+|\bpi\b)' .github/` | **MEDIUM** | `node scripts/check-no-earendil.mjs` + YAML syntax check | No |

### Batch Execution Rules

1. **Batch A1 + D must land before lockfile / shrinkwrap regeneration:**
   - Update `scripts/check-pinned-deps.mjs:27` (`isInternalWorkspaceDependency` checking `@bramburn/qi-`).
   - Update `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs`, then run:
     ```bash
     bun run shrinkwrap:coding-agent
     bun run install-lock:coding-agent
     ```
2. **Batch A2 care points:**
   - Do **not** blindly sed `\bpi\b` in math contexts (`Math.PI`, `2 * pi`, SVG/canvas geometry).
   - Extension loader (`packages/coding-agent/src/core/extensions/loader.ts:57-70,111-135`) bundled module aliases must resolve `@bramburn/qi-*` (hard cut per D1/D2).
3. **Immutable Historical Sections:**
   - Per `AGENTS.md` Changelog rules, released version headings and entries in `packages/*/CHANGELOG.md` below `## [Unreleased]` are immutable historical records and must be excluded from the CI brand guard.

---

## 2. Exclusion Policy (Enforced by `scripts/check-no-earendil.mjs`)

| Category | Paths / Globs | Policy | Rationale |
|---|---|---|---|
| **F. Deferred / Out-of-band** | `types/**`, `lab/**` | **EXCLUDED** | Experimental/ambient surfaces excluded from the rebrand sweep and CI gate. |
| **G. Historical / Scratch** | `checkpoint-evidence/**`, `scratch/**`, `research/**`, `lab/**`, `specs/.history/**`, `packages/*/CHANGELOG.md` | **EXCLUDE-FOREVER** | Historical evidence, research notes, and immutable past changelog entries must never be rewritten. |
| **H. Generated / Lock / Worktrees** | `dist/**`, `node_modules/**`, `.git/**`, `.worktrees/**`, `worktrees/**`, `.claude/**`, `package-lock.json`, `bun.lock`, `packages/coding-agent/npm-shrinkwrap.json`, `packages/coding-agent/install-lock/**`, `packages/ai/src/models.generated.ts` | **NEVER TOUCH BY HAND** | Regenerated exclusively by build/lock/codegen scripts (`bun install`, `bun run build`, `bun run shrinkwrap:coding-agent`, `bun run install-lock:coding-agent`). |

---

## 3. Manual Migration Guide for Existing Users (Deliverable for Decision D1)

Per **D1 (Full hard cut)**, `qi` provides **zero runtime fallbacks or auto-migration** from `pi`, `.pi/`, or `PI_*`. Copy the section below into `docs/migration-pi-to-qi.md` and link it from `README.md`.

```markdown
# Migrating from `pi` to `qi` (Hard Cut)

`qi` is a hard-cut rename. Legacy `pi` binary names, `~/.pi` directories, `.pi/` project directories, and `PI_*` environment variables are no longer read.

## 1. Move User State (`~/.pi` → `~/.qi`)

Close all running agent sessions, then rename your global configuration directory:

```bash
# Linux / macOS / Git Bash
mv ~/.pi ~/.qi

# PowerShell (Windows)
Move-Item -Path "$HOME\.pi" -Destination "$HOME\.qi"
```

This preserves `agent/settings.json`, `agent/auth.json`, `agent/models.json`, `agent/sessions/`, `agent/themes/`, `agent/tools/`, `agent/bin/`, `agent/extensions/`, and `agent/subagent-specs/`.

## 2. Move Project State (`.pi/` → `.qi/`)

In each repository where you have project-scoped settings, custom agents (`.pi/agents/*.md`), or skills (`.pi/skills/`):

```bash
git mv .pi .qi
# Or if untracked:
mv .pi .qi
```

Update `.gitignore` entries from `.pi/` to `.qi/` if applicable.

## 3. Rename Environment Variables (`PI_*` → `QI_*`)

Update your shell profile (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`, or Windows Environment Variables) and CI secrets:

| Old (`pi`) | New (`qi`) |
|---|---|
| `PI_CODING_AGENT_DIR` | `QI_CODING_AGENT_DIR` |
| `PI_PACKAGE_DIR` | `QI_PACKAGE_DIR` |
| `PI_MODEL` / `PI_PROVIDER` | `QI_MODEL` / `QI_PROVIDER` |
| `PI_REASONING_LEVEL` | `QI_REASONING_LEVEL` |
| `PI_SESSION_FILE` / `PI_SESSION_ID` | `QI_SESSION_FILE` / `QI_SESSION_ID` |
| `PI_OFFLINE` | `QI_OFFLINE` |
| `PI_TELEMETRY` | `QI_TELEMETRY` |
| `PI_CACHE_RETENTION` | `QI_CACHE_RETENTION` |
| `PI_HARDWARE_CURSOR` / `PI_TRUE_COLOR` / `PI_HYPERLINKS` / `PI_IMAGE_PROTOCOL` | `QI_HARDWARE_CURSOR` / `QI_TRUE_COLOR` / `QI_HYPERLINKS` / `QI_IMAGE_PROTOCOL` |
| `PI_TUI_ESC_TIMEOUT` / `PI_CLEAR_ON_SHRINK` | `QI_TUI_ESC_TIMEOUT` / `QI_CLEAR_ON_SHRINK` |
| `PI_SUBAGENT_*` | `QI_SUBAGENT_*` |
| `PI_AI_DEBUG` / `PI_TIMING` / `PI_STARTUP_BENCHMARK` | `QI_AI_DEBUG` / `QI_TIMING` / `QI_STARTUP_BENCHMARK` |
| `PI_ALLOW_LOCKFILE_CHANGE` | `QI_ALLOW_LOCKFILE_CHANGE` |

## 4. Update CLI Invocations & Wrapper Scripts

Replace `pi` with `qi` in all scripts, aliases, editor integrations, and tmux helpers. Reinstall global packages under the `@bramburn/qi-coding-agent` scope.
```

---

## Traceability

- **Realises:** `REQ-REBRAND` (D1 full hard cut, D2 `@bramburn/qi-*` package identity, D4 sever upstream endpoints)
- **Depends on ADRs:** `ADR-0001`, `ADR-0002`
- **References:** `scripts/check-no-earendil.mjs`, `scripts/check-pinned-deps.mjs:1-66`, `package.json:14-48`
