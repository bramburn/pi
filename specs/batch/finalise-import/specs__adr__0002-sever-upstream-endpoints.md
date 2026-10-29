# ADR-0002: Sever all earendil-controlled endpoints and sync tooling

**Status:** accepted
**Date:** 2026-10-20
**Domain:** rebrand

## Context

Even after renaming the binary and packages per `ADR-0001`, the runtime and repository scripts remain coupled to upstream infrastructure controlled by `earendil-works`:
1. `pi.dev/api/latest-version` in `packages/coding-agent/src/utils/version-check.ts:5`
2. `pi.dev/api/report-install` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1360`
3. `pi.dev/api/installer/releases` in `packages/coding-agent/src/package-manager-cli.ts:50`
4. `pi.dev/install.sh` in installer and documentation surfaces
5. `pi.dev/changelog` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4643`
6. `pi.dev/session` in `packages/coding-agent/src/config.ts:528` and `packages/coding-agent/src/cli/args.ts:466`
7. `pi.dev/packages` in `packages/coding-agent/docs/packages.md:137`
8. Upstream binary release URL `https://github.com/earendil-works/pi-mono/releases/latest` (`packages/coding-agent/src/config.ts:346`) and upstream sync tooling (`scripts/sync-versions.js`, `scripts/README-sync-upstream.md`, `README.md:12-16`).

Human decisions `D4` and `D6` (`specs/batch/batch-context.md`) mandate severing all earendil-controlled endpoints immediately while deferring replacement endpoint infrastructure to a future phase.

## Decision

We will remove or disable every runtime network call, default URL constant, documentation link, and synchronization script targeting `pi.dev` or `earendil-works/pi`, without introducing replacement hosted endpoints in this phase.

## Consequences

**Positive:**
- Zero runtime network egress to `pi.dev` or `earendil-works` under any configuration (`R-REBRAND-007`).
- Eliminates false version-update notifications caused by comparing `qi` versions against upstream `pi` releases.
- Removes obsolete upstream merge instructions and publish-rename workarounds (`R-REBRAND-010`).

**Negative:**
- Automatic startup latest-version checks and binary self-update release lookups via `pi.dev` are disabled until replacement infrastructure is scheduled (`D6`, see `ADR-0006` for npm-registry self-update resolution).
- Session sharing (`/share`) no longer defaults to a hosted `pi.dev/session/` web viewer unless the user sets `QI_SHARE_VIEWER_URL` (`R-REBRAND-008`).

**Neutral:**
- `reportInstall()` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1360` is stubbed to a no-op without network I/O (`R22`), while `checkLatestVersion()` in `packages/coding-agent/src/utils/version-check.ts:5` severs `pi.dev/api/latest-version` and resolves against the npm registry packument per `ADR-0006`.
- When `QI_SHARE_VIEWER_URL` is unset, `getShareViewerUrl()` in `packages/coding-agent/src/config.ts:526-531` returns the raw GitHub Gist `html_url` so `/share` remains functional without `pi.dev` (`R23`).

## Alternatives considered

- **Keep `pi.dev/api/latest-version` version check only:** Rejected because upstream `pi` version numbers diverge from `qi` releases, causing misleading upgrade notices and leaking `qi` client metadata to `pi.dev` (`D4`).
- **Keep `pi.dev/api/report-install` telemetry ping:** Rejected because reporting `qi` installations to an upstream endpoint violates user privacy expectations and `D4`.
- **Deploy and wire `qi.dev` / custom mirror endpoints now:** Rejected because hosting and maintaining replacement version, telemetry, changelog, and session-viewer services is out of scope (`D6`).

## Compliance checklist

- [ ] `grep -rn 'pi\.dev' packages/*/src/ packages/coding-agent/docs/ README.md website/` returns zero matches.
- [ ] `grep -rn 'earendil-works' packages/*/src/ scripts/ .github/workflows/` returns zero matches (outside the temporary `ADR-0003` loader shim in `packages/coding-agent/src/core/extensions/loader.ts`; `packages/coding-agent/src/config.ts:346` points to `https://github.com/bramburn/pi/releases/latest`).
- [ ] `scripts/README-sync-upstream.md` and `scripts/fork-publish-rename.mjs` are removed from the tree.
- [ ] `packages/coding-agent/src/core/session-share.ts:29` uses `"qi.share"` and `packages/coding-agent/src/config.ts:526-531` reads `process.env.QI_SHARE_VIEWER_URL` with raw Gist URL fallback and no `pi.dev` fallback.
- [ ] Unit test asserts that startup version check and post-update install telemetry make zero `fetch` calls to `pi.dev` when `QI_OFFLINE` is unset.

## Traceability

- **Realises requirements:** `REQ-REBRAND` (`R-REBRAND-007`, `R-REBRAND-008`, `R-REBRAND-009`, `R-REBRAND-010`, `R-REBRAND-011`).
- **Depends on ADRs:** `ADR-0001`.
- **Referenced by specs:** `REQ-REBRAND`, `ADR-0006`.
