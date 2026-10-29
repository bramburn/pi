# ADR-0006: Resolve qi self-update version via npm registry packument

**Status:** accepted
**Date:** 2026-10-20
**Domain:** rebrand

## Context

`ADR-0002` severed both `pi.dev/api/latest-version` (`packages/coding-agent/src/utils/version-check.ts:5`) and `pi.dev/api/installer/releases` (`packages/coding-agent/src/package-manager-cli.ts:50`) per `D4`, while `D6` deferred hosting a replacement `qi` release-metadata service. Stubbing both endpoints to unconditional `undefined` left `qi update --self` (and `qi update`) non-functional for npm/bun global installs (`packages/coding-agent/src/package-manager-cli.ts:864-954`) and disabled startup update notifications (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`), even though `@bramburn/qi-coding-agent` is published directly to the public npm registry (`D2`, `ADR-0001`).

## Decision

We will resolve the latest `@bramburn/qi-coding-agent` version for `checkLatestVersion()` and `qi update --self` directly from the npm registry packument (`https://registry.npmjs.org/@bramburn%2fqi-coding-agent`), reading `dist-tags.latest` with a highest-semver fallback over `versions`, a 10-second timeout, and up to 3 attempts for `qi update --self`, while keeping `QI_OFFLINE` as a silent no-network skip and keeping managed-binary installer updates disabled by default behind the `QI_INSTALLER_API_BASE` operator escape hatch.

## Consequences

**Positive:**
- Restores `qi update --self` and startup version checks for npm/bun installs using the authoritative registry where `@bramburn/qi-coding-agent` is published, with zero `pi.dev` traffic (`R-REBRAND-007`).
- Handles pre-release fork versions (e.g. `0.85.0-b1`) deterministically via `dist-tags.latest` and semver comparison fallback when `dist-tags.latest` is absent.
- Preserves offline hermeticity (`QI_OFFLINE` / `QI_SKIP_VERSION_CHECK`) and keeps the staged managed-binary installer path safely gated unless an operator explicitly sets `QI_INSTALLER_API_BASE`.

**Negative:**
- Standalone managed-binary installs cannot self-update over the network by default until a replacement installer release feed is deployed (`D6`); users receive the manual GitHub releases instruction (`https://github.com/bramburn/pi/releases/latest`, `R-REBRAND-006`).
- Direct packument fetches download the package metadata JSON from `registry.npmjs.org` (bounded by a 10s abort timeout).

**Neutral:**
- Interactive startup calls `checkLatestVersion()` with a single attempt, whereas explicit `qi update --self` retries up to 3 times on transient network or 5xx failures before reporting an update check error.

## Alternatives considered

- **Keep `pi.dev/api/latest-version` and `pi.dev/api/installer/releases`:** Rejected because `ADR-0002` and `D4` permanently sever all earendil-controlled endpoints and upstream `pi` versions do not track `@bramburn/qi-coding-agent`.
- **Query GitHub Releases API (`api.github.com/repos/bramburn/pi/releases/latest`) as the version feed:** Rejected because GitHub releases do not provide the npm packument shape or `sha256` tarball manifest required by the staged managed-installer flow, and the manual binary fallback in `packages/coding-agent/src/config.ts:346` already directs binary users to `https://github.com/bramburn/pi/releases/latest`.
- **Spawn an `npm view` subprocess via `getLatestNpmVersion()`:** Rejected because `packages/coding-agent/src/utils/version-check.ts` is a lightweight, settings-free `fetch`-based utility used during early startup, whereas `getLatestNpmVersion()` (`packages/coding-agent/src/core/package-manager.ts:1491`) is bound to a `DefaultPackageManager` instance that is not instantiated at the `version-check.ts` or `package-manager-cli.ts` self-update call sites.

## Compliance checklist

- [ ] `packages/coding-agent/test/version-check.test.ts` asserts that `checkLatestVersion()` requests `https://registry.npmjs.org/@bramburn%2fqi-coding-agent` (or encoded package name), resolves `dist-tags.latest` with highest-semver fallback over `versions`, performs zero `fetch` calls when `QI_OFFLINE=1` or `QI_SKIP_VERSION_CHECK=1`, and retries up to 3 times when invoked for `update --self`.
- [ ] `packages/coding-agent/test/package-command-paths.test.ts` asserts the disabled-by-default managed-installer contract when `QI_INSTALLER_API_BASE` is unset and verifies that `QI_INSTALLER_API_BASE` overrides the installer feed when explicitly provided.
- [ ] `grep -rn 'pi\.dev' packages/coding-agent/src/utils/version-check.ts packages/coding-agent/src/package-manager-cli.ts` returns zero matches.

## Traceability

- **Realises requirements:** `REQ-REBRAND` (`R-REBRAND-004`, `R-REBRAND-006`, `R-REBRAND-007`).
- **Depends on ADRs:** `ADR-0001`, `ADR-0002`.
- **Referenced by specs:** `REQ-REBRAND`.
