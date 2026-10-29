# ADR-0001: Hard-cut rename to qi with no legacy aliases

**Status:** accepted
**Date:** 2026-10-20
**Domain:** rebrand

## Context

The repository is permanently diverging from upstream `earendil-works/pi` (`0.85.0-b1`). Across the monorepo there are ~4,604 occurrences of `earendil`, ~2,953 word-boundary occurrences of `pi`, 11 workspace packages named `@earendil-works/pi-*` (`packages/coding-agent/package.json:2,51-56`) rewritten only at publish time to `@bramburn/pi-*` (`scripts/fork-publish-rename.mjs:21-22`), user/project state paths hardcoded to `~/.pi/agent/` and `.pi/` (`packages/coding-agent/src/config.ts:509-596`), and ~40 literal `PI_*` environment variables (`packages/coding-agent/docs/environment-variables.md:1-97`, `src/config.ts:440,529`, `src/main.ts:762-765,1095`, `src/core/settings-manager.ts:1079,1152`) that do not derive from `APP_NAME`. Human decisions `D1` and `D2` (`specs/batch/batch-context.md`) govern requirements `R-REBRAND-001` through `R-REBRAND-006`, `R-REBRAND-009`, and `R-REBRAND-012`.

## Decision

We will execute a full hard-cut rename to `qi`—renaming the CLI binary to `qi`, root workspace to `qi-monorepo`, all 11 workspace packages to `@bramburn/qi-*`, state directories to `~/.qi/` and `.qi/`, and all `PI_*` environment variables to `QI_*`—with zero legacy aliases and zero automatic migration.

## Consequences

**Positive:**
- Eliminates dual-state ambiguity between concurrent `pi` and `qi` installations on the same machine.
- Removes publish-time package-name rewriting (`scripts/fork-publish-rename.mjs`) that caused shrinkwrap and install-lock mismatches (`AGENTS.md:323`).
- Makes every runtime surface (`APP_NAME`, `CONFIG_DIR_NAME`, `QI_*` env vars, child process markers) deterministic and auditable via static grep checks.

**Negative:**
- Existing users must manually move `~/.pi` to `~/.qi`, rename project `.pi/` directories to `.qi/`, and update `PI_*` environment variables in shell profiles (`R-REBRAND-012`).
- Existing scripts invoking `pi` or reading `PI_SESSION_ID` / `PI_CODING_AGENT` break immediately (`D1`).

**Neutral:**
- All 11 workspace `package.json` files are renamed in-tree to `@bramburn/qi-*` and `scripts/fork-publish-rename.mjs` (with its test) is deleted: D2 sets published package identity to `@bramburn/qi-*` and D1 requires a hard cut (publish-time rewriting is redundant once the tree is renamed).
- Config, CLI, and state surfaces drop every `@earendil-works` alias immediately under D1, while `packages/coding-agent/src/core/extensions/loader.ts` keeps a strictly-scoped temporary module-resolution shim (`@earendil-works/pi-*` → qi modules, confined to `loader.ts` ONLY) so pinned 0.85 extensions keep loading until porting (D3/D6); the shim is recorded as a temporary shim in ADR-0003.

## Alternatives considered

- **Phased dual-name period (`qi` + `pi` bin alias, `QI_* ?? PI_*` fallback, `~/.qi` fallback to `~/.pi`):** Rejected because maintaining fallback chains across ~40 literal env vars, child-process session markers (`docs/environment-variables.md:13-31`), and project trust stores (`src/core/trust-manager.ts`) doubles test complexity, risks mutating an active `pi` installation's state, and violates `D1`.
- **Deprecated alias layer with automatic `~/.pi` → `~/.qi` migration in `migrations.ts` (`src/main.ts:878`):** Rejected because copying or symlinking user state on startup surprises users running both tools and violates `D1` ("No auto-migration; document manual migration").
- **Keep `@earendil-works/pi-*` in-tree and rewrite to `@bramburn/qi-*` in `scripts/fork-publish-rename.mjs`:** Rejected because runtime constants (`config.ts:511`, `startup-ui.ts:33`, `loader.ts:57-70`) and lockfiles remain coupled to `@earendil-works/pi-*`, violating `R-REBRAND-002` and `R-REBRAND-009`.

## Compliance checklist

- [ ] `package.json:2` has `"name": "qi-monorepo"` and `grep -rn '@earendil-works/pi-\|@bramburn/pi-' package.json packages/*/package.json` returns zero matches.
- [ ] `packages/coding-agent/package.json:6-12` defines `"name": "@bramburn/qi-coding-agent"`, `"qiConfig": { "configDir": ".qi" }`, `"bin": { "qi": "dist/bundle/cli.js" }`, and `build:binary` outputs `dist/qi`.
- [ ] `packages/coding-agent/src/config.ts:511-520` exports `PACKAGE_NAME = pkg.name || "@bramburn/qi-coding-agent"`, `APP_NAME = "qi"`, `APP_TITLE = "qi"`, `CONFIG_DIR_NAME = ".qi"`, `ENV_AGENT_DIR = "QI_CODING_AGENT_DIR"`, and `ENV_SESSION_DIR = "QI_CODING_AGENT_SESSION_DIR"`.
- [ ] `grep -rn 'process\.env\.PI_\|PI_CODING_AGENT\|AI_AGENT=pi' packages/*/src/` returns zero matches.
- [ ] Automated test verifies `qi --version` prints `qi <version> [bramburn]`, `qi --help` contains zero `PI_` or `.pi` strings, and `PI_OFFLINE=1` / `~/.pi` are ignored at runtime.

## Traceability

- **Realises requirements:** `REQ-REBRAND` (`R-REBRAND-001`, `R-REBRAND-002`, `R-REBRAND-003`, `R-REBRAND-004`, `R-REBRAND-005`, `R-REBRAND-006`, `R-REBRAND-009`, `R-REBRAND-011`, `R-REBRAND-012`).
- **Depends on ADRs:** None.
- **Referenced by specs:** `ADR-0002`, `ADR-0003`, `ADR-0006`.
