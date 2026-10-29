# Impl: Extensions compat-pin implementation phase

**Realises:** `REQ-EXT` (`R-EXT-001`, `R-EXT-002`, `R-EXT-003`, `R-EXT-004`, `R-EXT-005`, `R-EXT-006`, `R-EXT-007`, `R-EXT-008`)
**Depends on phases:** none (coordinates with `REQ-REBRAND` for `@bramburn/qi-*` virtual module aliases in `loader.ts`)
**Verifies via:** `BEHAV-EXT-INSTALL-PINNING`, `packages/coding-agent/test/package-manager-compat-pinning.test.ts`, `packages/coding-agent/test/package-manager.test.ts`, `packages/coding-agent/test/package-manager-cli.test.ts`

## Work items (DAG)

| ID | Work item | Depends on | Realises | Verified by |
|---|---|---|---|---|
| W-01 | Create `packages/coding-agent/src/core/extension-compat-manifest.json` seeded from the 0.85 snapshot of npm keyword `pi-package` packages plus workspace examples, and add a typed loader/validator module `packages/coding-agent/src/core/extension-compat.ts` enforcing `CONTRACT-EXT-COMPAT-MANIFEST`. | — | REQ-EXT (R-EXT-005) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/package-manager-compat-pinning.test.ts` |
| W-02 | Define typed `PackageInstallError` (`E_EXT_NO_COMPATIBLE_VERSION`, `E_EXT_PACKAGE_NOT_FOUND`, `E_EXT_NETWORK_OR_REGISTRY`, `E_EXT_PROJECT_UNTRUSTED`) in `packages/coding-agent/src/core/package-manager.ts` (failing hard with `E_EXT_NO_COMPATIBLE_VERSION` when a listed package has zero matching versions unless `--force` is passed) and wire error formatting in `packages/coding-agent/src/package-manager-cli.ts:954-1100`. | W-01 | REQ-EXT (R-EXT-007) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/package-manager-cli.test.ts` |
| W-03 | Update `DefaultPackageManager.getLatestNpmVersion()` (`packages/coding-agent/src/core/package-manager.ts:1491-1511`) to query `npm view <name> versions --json` when resolving a range, and add `resolveCompatibleNpmSource()` to resolve unpinned npm installs against `extension-compat-manifest.json` via `semver.maxSatisfying`. | W-01, W-02 | REQ-EXT (R-EXT-001) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/package-manager-compat-pinning.test.ts` |
| W-04 | Implement unknown-package warning and `latest` resolution fallback in `resolveCompatibleNpmSource()` (`packages/coding-agent/src/core/package-manager.ts:1808-1812`), emitting a progress/warning event when a package is absent from the manifest or when an explicit user version falls outside `compatibleRange`. | W-03 | REQ-EXT (R-EXT-004) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/package-manager-compat-pinning.test.ts` |
| W-05 | Update `DefaultPackageManager.install()` (`packages/coding-agent/src/core/package-manager.ts:1005-1027`) and `installAndPersist()` (`:1029-1032`) to return the canonical pinned source string (`npm:<name>@<resolvedVersion>`), persist that exact string via `addSourceToSettings()` (`:840-873`) while preserving existing `PackageFilter` objects, and log the resolved spec in `packages/coding-agent/src/package-manager-cli.ts:956`. | W-03, W-04 | REQ-EXT (R-EXT-002) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/package-manager-compat-pinning.test.ts` |
| W-06 | Verify and lock in `parsed.pinned` update-skipping in `updateConfiguredSources()` (`packages/coding-agent/src/core/package-manager.ts:1106-1109`) and `checkForAvailableUpdates()` (`:1203-1205`) for newly persisted `npm:<name>@<resolvedVersion>` entries. | W-05 | REQ-EXT (R-EXT-003) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/package-manager.test.ts` |
| W-07 | Update `DefaultPackageManager.installGit()` (`packages/coding-agent/src/core/package-manager.ts:1829-1862`) and `parseSource()` (`:1446-1472`) so unpinned git sources matching a manifest `gitUrl` apply the manifest's `gitRef` and persist `<source>@<gitRef>` in `settings.json`. | W-01, W-05 | REQ-EXT (R-EXT-006) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/package-manager-compat-pinning.test.ts` |
| W-08 | Audit `packages/coding-agent/src/core/extensions/loader.ts:46-136,498-513` and `packages/coding-agent/docs/packages.md` to remove `pi.dev/packages` runtime/doc couplings, retain the temporary loader-scoped `@earendil-works/pi-*` → `@bramburn/qi-*` resolution shim (`ADR-0003`), and verify transactional rollback (`load.discard()`) and error reporting on incompatible extension factories. | W-01 | REQ-EXT (R-EXT-008) | BEHAV-EXT-INSTALL-PINNING, `packages/coding-agent/test/extension-loader.test.ts` |

`DefaultPackageManager.install()`'s signature is widened from `Promise<void>` to `Promise<string>`, returning the resolved persisted source string (the conservative alternative keeps `Promise<void>` while a private helper returns the resolved source to `installAndPersist`), without breaking external callers: the `PackageManager` interface at `package-manager.ts:96-110` is internal to `@bramburn/qi-coding-agent` and `tsgo --noEmit` catches any missed caller.

The exact initial package list for `packages/coding-agent/src/core/extension-compat-manifest.json` is seeded in W-01 from the 0.85 snapshot of npm keyword `pi-package` packages plus the workspace examples (registry-side discovery is permitted; do not scrape the severed `pi.dev/packages` gallery), satisfying D3's checked-in 0.85 ecosystem snapshot requirement (`R-EXT-005`).

## Verification strategy

- **Schema & static checks (`bun run check`):**
  - Validate `packages/coding-agent/src/core/extension-compat-manifest.json` against `specs/contracts/json-schema/extension-compat-manifest.schema.json` in a unit test and in `bun run check`.
  - Run `bun run check` at repo root (Biome lint/format, `check:pinned-deps`, `check:ts-imports`, `tsgo --noEmit`).
- **Unit & integration tests (Vitest via Node/Bun runner per `AGENTS.md`):**
  - Run `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/package-manager-compat-pinning.test.ts` from `packages/coding-agent`:
    - Mock `runCommandCapture` (`npm view <pkg> versions --json`) and `runNpmCommand` (`npm install`) to verify:
      1. Listed unpinned `npm:alpha-ext` resolves highest version matching `compatibleRange` (`1.4.2`, skipping `2.0.0`) and writes `"npm:alpha-ext@1.4.2"` to `settings.json`.
      2. Listed unpinned package with no matching version throws `PackageInstallError` with code `E_EXT_NO_COMPATIBLE_VERSION` (unless `--force` is supplied) and leaves `settings.json` untouched.
      3. Unlisted unpinned `npm:unlisted-ext` emits a compatibility warning, resolves `latest` (`0.2.0`), installs `unlisted-ext@0.2.0`, and writes `"npm:unlisted-ext@0.2.0"` to `settings.json`.
      4. Listed unpinned git URL checks out `gitRef` from manifest and persists `@<gitRef>` in `settings.json`.
      5. Subsequent `packageManager.update()` skips all packages persisted with `@<exactVersion>`.
  - Run existing regression suites: `test/package-manager.test.ts`, `test/package-manager-cli.test.ts`, and `test/extension-loader.test.ts` from `packages/coding-agent`.

## Rollback

- Revert commits touching `packages/coding-agent/src/core/package-manager.ts`, `packages/coding-agent/src/package-manager-cli.ts`, and `packages/coding-agent/src/core/extension-compat.ts`.
- Any entries already persisted as `"npm:<name>@<exactVersion>"` or `"<gitUrl>@<gitRef>"` in user (`~/.qi/agent/settings.json`) or project (`.qi/settings.json`) files remain 100% valid syntax for the pre-change `parseSource()` implementation (`packages/coding-agent/src/core/package-manager.ts:1446-1472`), so rollback requires no user settings migration.

## Out of scope

- **Self-hosted registry mirror:** Running or proxying a custom npm registry or git mirror for extensions (deferred per Decision D6).
- **Live gallery scraping:** Fetching or scraping `https://pi.dev/packages` or the npm search API at runtime or via scheduled CI jobs (severed per Decision D4).
- **Extension authoring and migration guide:** Writing documentation for third-party authors on porting extensions to `qi` (deferred per Decision D6).
- **Runtime version handshake in `loader.ts`:** Enforcing `engines.qi` or `API_VERSION` checks at extension load time (`batch-context.md` §3.2).

## Traceability

- **Realises:** `REQ-EXT` (`R-EXT-001`, `R-EXT-002`, `R-EXT-003`, `R-EXT-004`, `R-EXT-005`, `R-EXT-006`, `R-EXT-007`, `R-EXT-008`)
- **Depends on ADRs:** `ADR-0003`
- **References:** `CONTRACT-EXT-COMPAT-MANIFEST`, `BEHAV-EXT-INSTALL-PINNING`
