# ADR-0006: qi self-update resolves versions from the npm registry

**Status:** accepted
**Date:** 2026-10-20
**Domain:** rebrand

## Context

`ADR-0002` (Decision D4) severed `pi.dev/api/latest-version` (`packages/coding-agent/src/utils/version-check.ts`) and `pi.dev/api/installer/releases` (`packages/coding-agent/src/package-manager-cli.ts:50`) while Decision D6 deferred replacement endpoint infrastructure, leaving `qi update --self` and startup update notifications without a version source. `R-REBRAND-007` requires zero `pi.dev` traffic under any configuration, and the binary-install manual fallback already points users at the fork's GitHub releases (`getSelfUpdateUnavailableInstruction` in `config.ts`). The tree already contains the settings-free fetch utility and its tests (`test/version-check.test.ts`) plus the disabled-managed-flow contract test (`test/package-command-paths.test.ts:703`), so this ADR records an implemented decision rather than a pending one.

## Decision

We will resolve qi's latest version from the npm registry packument of `@bramburn/qi-coding-agent` — `dist-tags.latest` via `https://registry.npmjs.org` (10-second request timeout, retry ×3 on the self-update path) — with `QI_OFFLINE` degrading to a silent, network-free skip, and with managed installer self-update disabled by default behind `QI_INSTALLER_API_BASE` (`DEFAULT_INSTALLER_API_BASE = ""`). `ADR-0002` holds: every `pi.dev` and `earendil-works` endpoint stays severed, and no replacement hosted service is introduced.

## Consequences

**Positive:**
- `qi update --self` and startup update notices work with zero earendil-controlled egress (`R-REBRAND-007`).
- The published registry metadata is the single version source of truth, produced by the same OIDC publish pipeline that ships the packages.
- `QI_OFFLINE` and retry behaviour are deterministic and unit-tested without network access.

**Negative:**
- Version resolution now depends on public registry availability and install-v1 packument shape; a stale or wrong `dist-tags.latest` would surface a wrong update notice.
- Managed (installer-based) binary self-update stays unavailable until an operator hosts a compatible installer endpoint.

**Neutral:**
- The startup check remains best-effort (`checkForNewQiVersion` swallows failures and returns `undefined`); manual binary installs keep pointing at GitHub releases.
- `ADR-0002`'s severance and `D6`'s deferral of replacement hosted services are unchanged.

## Alternatives considered

- **Keep the `pi.dev` endpoints:** Rejected — severed by `ADR-0002` / D4; upstream `pi` versions diverge from `qi` and would leak client metadata to earendil hosts.
- **GitHub-releases version feed:** Rejected — releases JSON has no packument shape (no `dist-tags`) for the managed flow's version selection, and the manual fallback already points there.
- **`npm view` subprocess:** Rejected — version checking lives in a settings-free startup utility where fetch plumbing already exists; spawning a subprocess adds process overhead plus a PATH/registry-CLI dependency for nothing.

## Compliance checklist

- [ ] `test/version-check.test.ts` asserts the registry URL, `dist-tags.latest` extraction (with highest-version fallback), offline (`QI_OFFLINE`) no-fetch, and retry ×3.
- [ ] `test/package-command-paths.test.ts` asserts the disabled-managed contract: with `QI_INSTALLER_API_BASE` unset, managed self-update reports `Managed qi self-update is disabled: no installer release endpoint is configured.` and stages nothing.
- [ ] `grep -rn 'pi\.dev' packages/coding-agent/src/utils/version-check.ts packages/coding-agent/src/package-manager-cli.ts` returns zero matches.

## Traceability

- **Realises requirements:** `REQ-REBRAND` (`R-REBRAND-006`, `R-REBRAND-007`).
- **Depends on ADRs:** `ADR-0002`.
- **Referenced by specs:** `REQ-REBRAND`, `ADR-0002` (endpoint severance holds; version feed replaced).
