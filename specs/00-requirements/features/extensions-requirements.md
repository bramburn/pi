# Extensions Requirements

## Scope

This specification governs how the coding agent resolves, installs, persists, updates, and loads third-party extension packages after the hard-cut fork at the 0.85 compatibility baseline. In scope are install-time version resolution against a bundled compatibility manifest, configuration persistence of resolved versions, preservation of pinned-version update semantics, handling of unlisted packages, source-control revision pinning, structured installation error reporting, and extension loader compatibility boundaries. Out of scope are self-hosted package mirrors, live catalog scraping, and runtime protocol negotiation.

## Requirements

### R-EXT-001: Compatibility manifest resolution for unpinned registry installs

**Priority:** MUST
**Statement:** When a user installs an unpinned package from the package registry that is listed in the bundled compatibility manifest, the system resolves the highest available version satisfying the manifest's compatibility constraint for installation.
**Rationale:** Currently `DefaultPackageManager.installNpm()` (`packages/coding-agent/src/core/package-manager.ts:1808-1812`) passes `source.spec` verbatim to `npm`/`bun`/`pnpm`, which resolves unpinned specs to registry `latest`. As upstream advances past 0.85, `latest` will pull breaking changes into `qi`. Reusing the existing `semver.maxSatisfying` resolution machinery (`packages/coding-agent/src/core/package-manager.ts:1491-1526`) against a checked-in compatibility manifest (Decision D3) pins installs to known-good 0.85 releases. An explicit user version or range in an install command overrides the manifest's default constraint and emits a warning when it falls outside the compatible range, giving users who test a forked or patched extension version an override path (`package-manager.ts:1446-1458`; recorded under Neutral consequences in ADR-0003).
**Acceptance criteria:**
- AC1: Given package `alpha` is listed in the compatibility manifest with constraint `<=1.4.2` and the package registry offers versions `1.4.0`, `1.4.2`, and `2.0.0`, when the user requests installation of unpinned `alpha`, then the system resolves and installs version `1.4.2`.
- AC2: Given package `alpha` is listed in the compatibility manifest with constraint `<=1.4.2`, when the user requests installation of `alpha` at explicit version `2.0.0`, then the system emits a compatibility warning and installs version `2.0.0`.
**Source:** Decision D3; `specs/batch/batch-context.md` §1, §3.2

### R-EXT-002: Persistence of exact resolved version in configuration

**Priority:** MUST
**Statement:** Upon completing an unpinned package registry installation, the system records the package source with its exact resolved version identifier in the target configuration scope.
**Rationale:** `DefaultPackageManager.installAndPersist()` (`packages/coding-agent/src/core/package-manager.ts:1029-1032`) currently calls `addSourceToSettings(source, options)` (`:840-873`) with the raw user input string (for example `"npm:foo"`), leaving the saved entry unpinned (`pinned: false` at `:1456`). Persisting `"npm:<name>@<resolvedVersion>"` (Decision D3) ensures `isExactNpmVersion()` (`:59-61`) classifies the persisted entry as pinned so future sessions and updates are deterministic. Startup auto-installation (`resolvePackageSources()`, `package-manager.ts:1246-1320`) and temporary `-e` runs (`resolveExtensionSources()`, `:965-972`) resolve against the compatibility manifest for installation without mutating `settings.json`: only the explicit `installAndPersist()` path writes settings files, which keeps startup read-only and installs deterministic session-to-session.
**Acceptance criteria:**
- AC1: Given user configuration initially has no entry for `alpha` and the unpinned install of `alpha` resolves to version `1.4.2`, when installation succeeds in user scope, then user configuration contains the exact entry for `alpha` at version `1.4.2`.
- AC2: Given project configuration already contains an unpinned entry for `alpha` and the user runs an unpinned install of `alpha` in project scope that resolves to `1.4.2`, when installation succeeds, then the existing project configuration entry is updated in place to version `1.4.2` while preserving any resource filters on that entry.
**Source:** Decision D3; `specs/batch/batch-context.md` §1, §3.2

### R-EXT-003: Preservation of pinned-version immutability during updates

**Priority:** MUST
**Statement:** During bulk or targeted package update operations, the system leaves any configured package with an exact version identifier unchanged.
**Rationale:** `DefaultPackageManager.updateConfiguredSources()` (`packages/coding-agent/src/core/package-manager.ts:1106-1109`) and `checkForAvailableUpdates()` (`:1203-1205`) skip npm sources where `parsed.pinned === true` (`:59-61`, `:1456`). Preserving this invariant ensures that once `installAndPersist()` writes an exact 0.85-compatible version, `qi update --extensions` and `qi update --all` never advance the package onto an incompatible post-0.85 release.
**Acceptance criteria:**
- AC1: Given configuration contains package `alpha` pinned to exact version `1.4.2` and version `2.0.0` is available in the package registry, when the user runs a package update across all extensions, then `alpha` remains at version `1.4.2` with no registry install invocation for `alpha`.
- AC2: Given configuration contains package `beta` with a non-exact version range `^1.0.0` and version `1.3.0` is available in the package registry, when the user runs a package update across all extensions, then `beta` updates to `1.3.0`.
**Source:** Decision D3; `specs/batch/batch-context.md` §3.2

### R-EXT-004: Warning and latest-version fallback for unknown registry packages

**Priority:** MUST
**Statement:** When a user installs an unpinned package from the package registry that is absent from the bundled compatibility manifest, the system emits a compatibility warning before falling back to the latest available registry version.
**Rationale:** Decision D3 mandates that unknown extensions must not be refused; instead the installer warns that 0.85 compatibility is unverified, resolves `latest` from the npm registry via `getLatestNpmVersion()` (`packages/coding-agent/src/core/package-manager.ts:1491-1511`), installs that version, and persists the exact resolved version so subsequent updates do not silently drift.
**Acceptance criteria:**
- AC1: Given package `unlisted-pkg` is not present in the compatibility manifest and its latest version in the package registry is `0.4.1`, when the user requests installation of unpinned `unlisted-pkg`, then the system outputs a warning stating `unlisted-pkg` is not in the compatibility manifest, installs version `0.4.1`, and persists `unlisted-pkg` at exact version `0.4.1` in configuration.
- AC2: Given package `unlisted-pkg` is not present in the compatibility manifest, when the user requests installation of unpinned `unlisted-pkg`, then the installation command exits with status zero if the package exists in the registry.
**Source:** Decision D3; `specs/batch/batch-context.md` §1, §3.2

### R-EXT-005: Bundled compatibility manifest coverage for the 0.85 extension ecosystem

**Priority:** MUST
**Statement:** The system includes a checked-in compatibility manifest that maps known 0.85-era ecosystem packages to verified version constraints without contacting external catalog services at runtime.
**Rationale:** Upstream extensions are discovered via the npm keyword `pi-package` and the `pi.dev/packages` gallery (`packages/coding-agent/docs/packages.md:107-146`). Decision D4 severs all `pi.dev` endpoints, and Decision D3 requires a checked-in compatibility manifest in the repository covering the 0.85 ecosystem snapshot.
**Acceptance criteria:**
- AC1: Given offline mode or network isolation from upstream catalog hosts, when the package installer resolves a listed package, then the compatibility manifest is loaded entirely from local bundled assets with zero outbound requests to upstream gallery endpoints.
- AC2: Given the checked-in compatibility manifest file in the repository, when validated against the manifest contract schema during build checks, then every entry contains a valid package identifier, a non-empty compatibility constraint, and an audit date.
**Source:** Decisions D3, D4; `specs/batch/batch-context.md` §1, §3.2

### R-EXT-006: Revision-reference pinning for source-control repository installs

**Priority:** MUST
**Statement:** When installing a package from a source-control repository, the system checks out and persists the explicit revision reference provided by the caller or the default revision reference recorded in the compatibility manifest.
**Rationale:** `DefaultPackageManager.installGit()` (`packages/coding-agent/src/core/package-manager.ts:1829-1862`) and `updateGit()` (`:1864-1878`) already pin checkouts when `source.ref` is supplied (`src/utils/git.ts`). When a user installs an unpinned git URL that matches a `gitUrl` entry in the compatibility manifest, applying the manifest's `gitRef` prevents cloning an incompatible `HEAD` from upstream default branches. Installing such an unpinned git source rewrites the persisted `settings.json` string to include `@<gitRef>` so `update --extensions` reconciles to that ref (`installGit`/`updateGit` at `package-manager.ts:1829-1878` already pin when `source.ref` is supplied); without persistence, updates would re-resolve upstream HEAD and silently advance the checkout.
**Acceptance criteria:**
- AC1: Given the user installs a source-control repository with explicit revision reference `v1.2.0`, when installation completes, then the local checkout is pinned to `v1.2.0` and configuration stores the source with `@v1.2.0`.
- AC2: Given the user installs a source-control repository without a revision reference and the repository is listed in the compatibility manifest with default revision reference `v1.4.2`, when installation completes, then the local checkout is pinned to `v1.4.2` and configuration stores the source with `@v1.4.2`.
**Source:** Decision D3; `specs/batch/batch-context.md` §3.2

### R-EXT-007: Typed failure reasons for package installation errors

**Priority:** MUST
**Statement:** When package resolution or installation fails, including when a manifest-listed package has no registry version satisfying its compatibility constraint and force override is not requested, the system aborts without modifying configuration while reporting a categorized failure reason to the caller.
**Rationale:** `DefaultPackageManager.install()` (`packages/coding-agent/src/core/package-manager.ts:1005-1027`) and `handlePackageCommand()` (`packages/coding-agent/src/package-manager-cli.ts:1096-1100`) currently surface generic string errors from child processes (`npm view` / `npm install`). Introducing a typed error code distinguishes: (1) `E_EXT_NO_COMPATIBLE_VERSION` when a manifest-listed package has no registry version satisfying `compatibleRange`, (2) `E_EXT_PACKAGE_NOT_FOUND` when the package does not exist in the registry, (3) `E_EXT_NETWORK_OR_REGISTRY` when offline or registry lookup times out, and (4) `E_EXT_PROJECT_UNTRUSTED` when `-l` targets an untrusted project (`package-manager.ts:1741-1745`). A manifest-listed package with zero registry versions matching `compatibleRange` fails hard with `E_EXT_NO_COMPATIBLE_VERSION` unless `--force` is supplied: D3's warn-and-install-latest fallback (R-EXT-004) applies to UNKNOWN packages only, because falling back to `latest` for a LISTED package would install exactly the incompatible release D3 exists to block.
**Acceptance criteria:**
- AC1: Given package `alpha` is listed in the compatibility manifest with constraint `<=1.4.2` and the package registry only contains version `2.0.0`, when the user attempts to install unpinned `alpha` without the force override flag, then installation fails with reason `E_EXT_NO_COMPATIBLE_VERSION` and configuration remains unchanged.
- AC2: Given offline mode is enabled and package `alpha` is not cached locally, when the user attempts to install `alpha`, then installation fails with reason `E_EXT_NETWORK_OR_REGISTRY` and configuration remains unchanged.
**Source:** Decision D3; `specs/batch/batch-context.md` §3.2

### R-EXT-008: Truthful host compatibility boundary during extension loading

**Priority:** MUST
**Statement:** The extension host abstains from claiming unverified runtime interface compatibility when loading extensions, surfacing any load-time failure with the offending extension identifier while resolving both current host module specifiers and legacy 0.85 host module specifiers to the bundled host runtime.
**Rationale:** `packages/coding-agent/src/core/extensions/loader.ts:46-136` aliases `@bramburn/qi-*` as primary alongside a strictly loader-scoped temporary shim for `@earendil-works/pi-*` and `@mariozechner/pi-*` to bundled host modules without any `API_VERSION`, `minPiVersion`, or `engines` check (`batch-context.md` §3.2; ADR-0003). Because runtime API negotiation and extension porting are deferred (Decision D6), the host relies on install-time manifest pinning plus the loader-scoped module alias shim so unported 0.85 extensions load, and must not silently swallow or misattribute extension load failures (`loader.ts:498-513`).
**Acceptance criteria:**
- AC1: Given an installed extension imports a missing symbol from the host module surface and throws during factory initialization, when the extension loader runs, then it discards partial registrations for that extension and records a load error naming the extension path and underlying failure message.
- AC2: Given an extension package declares arbitrary host engine fields in its package metadata, when the extension loader loads the extension, then the host neither rejects nor claims verified compatibility based on those fields.
**Source:** Decisions D3, D6; `specs/batch/batch-context.md` §1, §3.2

## Traceability

- **Realises:** `REQ-EXT` (`R-EXT-001` through `R-EXT-008`)
- **Depends on ADRs:** `ADR-0003`
- **Referenced by:** `CONTRACT-EXT-COMPAT-MANIFEST`, `BEHAV-EXT-INSTALL-PINNING`, `IMPL-EXTENSIONS`
