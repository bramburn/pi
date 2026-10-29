# qi Spec Index

Single entry point for the qi spec set (Universal Spec Guidance, `specs/GUIDE.md`).
`specs/manifest.json` is the **only source of truth** for spec status, ids, paths, and batch derivation.

- **Mode:** `hybrid` (brownfield core; some domains describe pending batch work)
- **Stack:** `typescript`, `bun`

## Domains

- **`rebrand`** — Hard-cut rename from `pi` to `qi` (`@bramburn/qi-*`, `qi` binary, `QI_*` environment variables, `~/.qi/` and `.qi/` state directories) and complete severance of upstream `earendil-works`/`pi.dev` endpoints and sync tooling.
- **`extensions`** — Checked-in 0.85 compatibility manifest resolved at extension install time, persisting exact pinned versions in settings and warning while installing `latest` for unlisted packages.
- **`subagents`** — Native subagent subsystem (`packages/coding-agent/src/core/subagent/`) self-sufficiency and closure of all actionable P1/P2 defects and gaps.
- **`compaction`** — Typed skip outcomes and threshold skip-latching so compaction no-ops ("already compacted", "nothing to summarise") never surface as repeated red TUI errors or error telemetry.

## Spec count per type

| Type | Count |
|---|---|
| requirements | 5 |
| adr | 6 |
| contract | 2 |
| behavior | 1 |
| impl | 3 |
| ux | 0 (`not_applicable`) |
| **Total** | **17** (all `accepted`) |

## The 5 most recently accepted ADRs

| ADR | Decision (one line) |
|---|---|
| [ADR-0002](adr/0002-sever-upstream-endpoints.md) | Sever every earendil-controlled endpoint and sync tooling: zero `pi.dev` traffic, no replacement hosted services, `/share` falls back to the raw Gist URL. |
| [ADR-0003](adr/0003-extension-compat-manifest.md) | Checked-in extension compatibility manifest resolved at install: listed packages pin to `compatibleRange` (fail hard with `E_EXT_NO_COMPATIBLE_VERSION` unless `--force`), unknown packages warn and fall back to `latest`. |
| [ADR-0004](adr/0004-native-subagent-self-sufficiency.md) | The native subagent subsystem is the only subagent implementation: drop `pi-subagents` references and the legacy example extension, keep `packages/agent/src` free of subagent code. |
| [ADR-0005](adr/0005-compaction-skip-not-error.md) | A compaction no-op is a typed skip, not an error: typed skip reasons, `compaction_end` with `skipped: true` and no `errorMessage`, blocking `compact()` rejects `CompactionSkippedError`, `compactInBackground()` resolves `undefined`. |
| [ADR-0006](adr/0006-npm-registry-self-update.md) | qi self-update resolves the latest `@bramburn/qi-coding-agent` from the npm registry packument (`dist-tags.latest`, 10 s timeout, retry ×3, `QI_OFFLINE` = silent skip); managed installer update disabled by default behind `QI_INSTALLER_API_BASE`. |

(ADR-0001 — hard-cut rename to qi with no legacy aliases — is the accepted root decision; see [adr/0001-qi-hard-cut-rebrand.md](adr/0001-qi-hard-cut-rebrand.md).)

## Spec set at a glance

| id | type | domain | status | path |
|---|---|---|---|---|
| REQ-REBRAND | requirements | rebrand | accepted | [00-requirements/features/rebrand-requirements.md](00-requirements/features/rebrand-requirements.md) |
| ADR-0001 | adr | rebrand | accepted | [adr/0001-qi-hard-cut-rebrand.md](adr/0001-qi-hard-cut-rebrand.md) |
| ADR-0002 | adr | rebrand | accepted | [adr/0002-sever-upstream-endpoints.md](adr/0002-sever-upstream-endpoints.md) |
| ADR-0006 | adr | rebrand | accepted | [adr/0006-npm-registry-self-update.md](adr/0006-npm-registry-self-update.md) |
| REQ-EXT | requirements | extensions | accepted | [00-requirements/features/extensions-requirements.md](00-requirements/features/extensions-requirements.md) |
| ADR-0003 | adr | extensions | accepted | [adr/0003-extension-compat-manifest.md](adr/0003-extension-compat-manifest.md) |
| CONTRACT-EXT-COMPAT-MANIFEST | contract | extensions | accepted | [contracts/json-schema/extension-compat-manifest.schema.json](contracts/json-schema/extension-compat-manifest.schema.json) |
| CONTRACT-EXT-COMPAT-MANIFEST-EXAMPLES | contract | extensions | accepted | [contracts/json-schema/extension-compat-manifest.examples.md](contracts/json-schema/extension-compat-manifest.examples.md) |
| BEHAV-EXT-INSTALL-PINNING | behavior | extensions | accepted | [features/extensions/install-pinning.feature](features/extensions/install-pinning.feature) |
| IMPL-EXTENSIONS | impl | extensions | accepted | [impl/extensions-phase.md](impl/extensions-phase.md) |
| REQ-SUBAG | requirements | subagents | accepted | [00-requirements/features/subagents-requirements.md](00-requirements/features/subagents-requirements.md) |
| REQ-SUBAG-REGISTER | requirements | subagents | accepted | [subagent/requirements.md](subagent/requirements.md) |
| ADR-0004 | adr | subagents | accepted | [adr/0004-native-subagent-self-sufficiency.md](adr/0004-native-subagent-self-sufficiency.md) |
| IMPL-SUBAGENTS | impl | subagents | accepted | [impl/subagents-phase.md](impl/subagents-phase.md) |
| REQ-COMPACTION | requirements | compaction | accepted | [00-requirements/features/compaction-requirements.md](00-requirements/features/compaction-requirements.md) |
| ADR-0005 | adr | compaction | accepted | [adr/0005-compaction-skip-not-error.md](adr/0005-compaction-skip-not-error.md) |
| IMPL-COMPACTION | impl | compaction | accepted | [impl/compaction-phase.md](impl/compaction-phase.md) |

## How to use this in batch

Every batch task's context is derived **mechanically** from `specs/manifest.json` (GUIDE §7) — never hand-curate:

- **Review this code** (`specs_for(P)`): take every spec whose `governs` glob matches the code path `P`, then close over `depends_on` transitively. Example: a change in `packages/coding-agent/src/core/package-manager.ts` pulls `REQ-EXT`, `ADR-0003`, `CONTRACT-EXT-COMPAT-MANIFEST`, `CONTRACT-EXT-COMPAT-MANIFEST-EXAMPLES`, `IMPL-EXTENSIONS`, plus `ADR-0002` (via `governs: packages/coding-agent/src/**`) and its dependency `ADR-0001`.
- **Review this domain** (`specs_for(D)`): take every spec with `domain == D`; its code context is the union of those specs' `governs` globs. Example: domain `compaction` → `REQ-COMPACTION`, `ADR-0005`, `IMPL-COMPACTION` → `agent-session.ts`, `compaction/compaction.ts`, `interactive-mode.ts`.
- **Truth in advertising:** behavior specs carry `verifies` (test bindings) or `aspirational: true` (`BEHAV-EXT-INSTALL-PINNING` is aspirational until `IMPL-EXTENSIONS` wires the step definitions).
- **Status:** only `accepted` (or `superseded`) specs may appear in `depends_on`; all 17 entries are `accepted` as of 2026-10-20 (Phase E finalised, quality gates G1–G13 pass).

## The subagent subsystem sub-index

`specs/subagent/**` predates this spec set and keeps its **own conventions** (RFC-2119 normative language, `EXISTING`/`GAP`/`DEFECT` status vocabulary, `REQ-nnn` register ids, `path:line` citations). Its index lives at [`specs/subagent/README.md`](subagent/README.md); the register itself is `subagent/requirements.md` (manifest id `REQ-SUBAG-REGISTER`).

---

_Quality gates and authoring protocol: [`GUIDE.md`](GUIDE.md). Draft history: `specs/.history/` (not scanned by batch tools)._
