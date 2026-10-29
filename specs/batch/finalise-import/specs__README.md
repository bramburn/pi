# qi Specification Index

Single entry point for the `qi` specification set. [`specs/manifest.json`](manifest.json) is the machine-readable source of truth for spec identity, status, domain ownership, dependencies, and governed code paths; author and maintain specs per [`specs/GUIDE.md`](GUIDE.md).

## Domains

- **`rebrand`** — Hard-cut rename from `pi` to `qi` (`@bramburn/qi-*`, `qi` binary, `QI_*` environment variables, `~/.qi/` and `.qi/` state directories) and complete severance of upstream `earendil-works`/`pi.dev` endpoints and sync tooling.
- **`extensions`** — Checked-in 0.85 compatibility manifest resolved at extension install time, persisting exact pinned versions in settings and warning while installing `latest` for unlisted packages.
- **`subagents`** — Native subagent subsystem (`packages/coding-agent/src/core/subagent/`) self-sufficiency and closure of all actionable P1/P2 defects and gaps.
- **`compaction`** — Typed skip outcomes and threshold skip-latching so compaction no-ops ("already compacted", "nothing to summarise") never surface as repeated red TUI errors or error telemetry.

> **Subagent subsystem specifications.** The pre-existing native-subagent specification tree retains its own layout and status vocabulary (`EXISTING` / `GAP` / `DEFECT` / `REJECTED`) under [`specs/subagent/`](subagent/), indexed at [`specs/subagent/README.md`](subagent/README.md) with its normative register at [`specs/subagent/requirements.md`](subagent/requirements.md) (`REQ-SUBAG-REGISTER`).

## Spec count per type

Derived from [`specs/manifest.json`](manifest.json) (17 accepted specs total; `ux` is recorded as `not_applicable` in the manifest):

| Type | Count |
|---|---|
| `requirements` | 5 |
| `adr` | 6 |
| `contract` | 2 |
| `behavior` | 1 |
| `impl` | 3 |
| `ux` | 0 (`not_applicable`) |
| **Total** | **17** |

## 5 most recently accepted ADRs

- **[`ADR-0006`](adr/0006-npm-registry-self-update.md) — qi self-update via the npm registry:** Resolves latest version checks and self-update installs directly against the public npm registry (`@bramburn/qi-coding-agent`) after severing `pi.dev` installer endpoints.
- **[`ADR-0005`](adr/0005-compaction-skip-not-error.md) — Compaction no-op is a typed skip, not a user-facing error:** Represents "already compacted" and "nothing to summarise" branch states as typed skip outcomes with threshold latching instead of throwing error strings or reporting telemetry errors.
- **[`ADR-0004`](adr/0004-native-subagent-self-sufficiency.md) — Native subagent subsystem is the only subagent implementation:** Establishes the built-in `packages/coding-agent/src/core/subagent/` subsystem as the sole subagent implementation and removes external `pi-subagents` references and upstream extension examples.
- **[`ADR-0003`](adr/0003-extension-compat-manifest.md) — Extension compatibility manifest resolved at install:** Resolves unpinned extension installs against a checked-in 0.85 compatibility manifest, persisting exact pinned versions and aliasing `@earendil-works/pi-*` imports to `@bramburn/qi-*` in the extension loader.
- **[`ADR-0002`](adr/0002-sever-upstream-endpoints.md) — Sever all earendil-controlled endpoints and sync tooling:** Removes all runtime calls and documentation links to `pi.dev` endpoints and deletes upstream synchronisation and publish-rename scripts.

*(See also [`ADR-0001`](adr/0001-qi-hard-cut-rebrand.md) — Hard-cut rename to `qi` with no legacy aliases.)*

## How to use this in batch

[`specs/manifest.json`](manifest.json) is the single source of truth for status and context selection (see [`specs/GUIDE.md` §7](GUIDE.md)). Batch review and implementation runners derive task context mechanically from the manifest without manual file curation:

1. **Code → Specs (`specs_for(P)`):** Given a repository-relative file path `P`, select every spec in `manifest.specs` whose `governs` glob list matches `P`, then take the union with the transitive closure of `depends_on`:
   ```text
   specs_for(P) = { s in manifest.specs | s.governs matches P }
                ∪ { s in manifest.specs | s.id in transitive_depends_on(specs_for(P)) }
   ```
2. **Domain → Specs + Code (`specs_for(D)`, `code_for(D)`):** Given a domain `D` in `manifest.domains`, select all specs belonging to `D` and the union of their `governs` globs:
   ```text
   specs_for(D) = { s in manifest.specs | s.domain == D }
   code_for(D)  = union(s.governs for s in specs_for(D))
   ```

## Spec set at a glance

| ID | Type | Domain | Status | Path |
|---|---|---|---|---|
| `REQ-REBRAND` | `requirements` | `rebrand` | `accepted` | [`00-requirements/features/rebrand-requirements.md`](00-requirements/features/rebrand-requirements.md) |
| `ADR-0001` | `adr` | `rebrand` | `accepted` | [`adr/0001-qi-hard-cut-rebrand.md`](adr/0001-qi-hard-cut-rebrand.md) |
| `ADR-0002` | `adr` | `rebrand` | `accepted` | [`adr/0002-sever-upstream-endpoints.md`](adr/0002-sever-upstream-endpoints.md) |
| `ADR-0006` | `adr` | `rebrand` | `accepted` | [`adr/0006-npm-registry-self-update.md`](adr/0006-npm-registry-self-update.md) |
| `REQ-EXT` | `requirements` | `extensions` | `accepted` | [`00-requirements/features/extensions-requirements.md`](00-requirements/features/extensions-requirements.md) |
| `ADR-0003` | `adr` | `extensions` | `accepted` | [`adr/0003-extension-compat-manifest.md`](adr/0003-extension-compat-manifest.md) |
| `CONTRACT-EXT-COMPAT-MANIFEST` | `contract` | `extensions` | `accepted` | [`contracts/json-schema/extension-compat-manifest.schema.json`](contracts/json-schema/extension-compat-manifest.schema.json) |
| `CONTRACT-EXT-COMPAT-MANIFEST-EXAMPLES` | `contract` | `extensions` | `accepted` | [`contracts/json-schema/extension-compat-manifest.examples.md`](contracts/json-schema/extension-compat-manifest.examples.md) |
| `BEHAV-EXT-INSTALL-PINNING` | `behavior` | `extensions` | `accepted` | [`features/extensions/install-pinning.feature`](features/extensions/install-pinning.feature) |
| `IMPL-EXTENSIONS` | `impl` | `extensions` | `accepted` | [`impl/extensions-phase.md`](impl/extensions-phase.md) |
| `REQ-SUBAG` | `requirements` | `subagents` | `accepted` | [`00-requirements/features/subagents-requirements.md`](00-requirements/features/subagents-requirements.md) |
| `REQ-SUBAG-REGISTER` | `requirements` | `subagents` | `accepted` | [`subagent/requirements.md`](subagent/requirements.md) |
| `ADR-0004` | `adr` | `subagents` | `accepted` | [`adr/0004-native-subagent-self-sufficiency.md`](adr/0004-native-subagent-self-sufficiency.md) |
| `IMPL-SUBAGENTS` | `impl` | `subagents` | `accepted` | [`impl/subagents-phase.md`](impl/subagents-phase.md) |
| `ADR-0005` | `adr` | `compaction` | `accepted` | [`adr/0005-compaction-skip-not-error.md`](adr/0005-compaction-skip-not-error.md) |
| `REQ-COMPACTION` | `requirements` | `compaction` | `accepted` | [`00-requirements/features/compaction-requirements.md`](00-requirements/features/compaction-requirements.md) |
| `IMPL-COMPACTION` | `impl` | `compaction` | `accepted` | [`impl/compaction-phase.md`](impl/compaction-phase.md) |

## Traceability

- **Requirements realised:** `REQ-REBRAND`, `REQ-EXT`, `REQ-SUBAG`, `REQ-SUBAG-REGISTER`, `REQ-COMPACTION`
- **ADRs referenced:** `ADR-0001`, `ADR-0002`, `ADR-0003`, `ADR-0004`, `ADR-0005`, `ADR-0006`
- **Other specs referenced:** `CONTRACT-EXT-COMPAT-MANIFEST`, `CONTRACT-EXT-COMPAT-MANIFEST-EXAMPLES`, `BEHAV-EXT-INSTALL-PINNING`, `IMPL-EXTENSIONS`, `IMPL-SUBAGENTS`, `IMPL-COMPACTION`
