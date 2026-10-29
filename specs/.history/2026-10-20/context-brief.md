# Context Brief — qi fork spec set

> Phase A artefact. Status: DRAFT — compaction section pending explorer report (`efc25922`).
> Guide: Universal Spec Guidance (to be saved as `specs/GUIDE.md`).

## Mode

**hybrid** — per-domain:
- `rebrand` — brownfield (rename of existing code)
- `extensions` — brownfield (install flow exists; compat manifest is greenfield)
- `subagents` — brownfield (subsystem + own spec set exist; open DEFECT/GAP rows)
- `compaction` — brownfield (error paths exist; pending explorer report)

## Stack

- **TypeScript on Bun** — monorepo (`packages/*`, bun workspaces), built with `bun`, tested with `bun test` + vitest config.
- Contracts → **typebox / JSON Schema** (appendix 8.3, Zod-equivalent; typebox already used in-tree).
- Behavior → bun-test bindings where tests exist, otherwise `aspirational: true`.
- Website is Docusaurus (React) — out of scope except rebrand strings.
- Stack appendix applied: 8.3 (TypeScript). UX: TUI changes are textual, not visual → `not_applicable` candidate (record reason in manifest).

## What exists (brownfield evidence)

Source: four exploration reports (2026-10-20), file:line cited.

### rebrand
- Root pkg `pi-monorepo`; **11 packages `@earendil-works/pi-*`**; bins `pi` (`coding-agent/package.json:11`) and `pi-ai`.
- Central hook `piConfig` (`coding-agent/package.json:6` → `config.ts:509-518`) drives `APP_NAME`/`CONFIG_DIR_NAME`/`ENV_AGENT_DIR`, but **bin name, package names, and literal `PI_*` env vars (~40) do not follow it**.
- `FORK_NAME = "bramburn"`; existing publish-time rename machinery `scripts/fork-publish-rename.mjs`.
- User state `~/.pi/agent/`, project `.pi/`; sessions `~/.pi/agent/sessions/<cwd>/*.jsonl`; share event type `pi.share`.
- Remotes: `origin` → earendil-works/pi, `fork` → bramburn/pi. ~4604 `earendil` / ~2953 word-boundary `pi` occurrences.
- Upstream calls: `pi.dev/api/latest-version`, `pi.dev/api/report-install`, `pi.dev/api/installer/releases`, `pi.dev/changelog`, `pi.dev/session`, gallery `pi.dev/packages`.

### extensions
- `pi install <source>` → `package-manager-cli.ts:864` → `core/package-manager.ts` `install()/installAndPersist()` (`:1005/:1029`).
- **Unpinned `npm:pkg` installs npm `latest` (`:1811`); no API-compat validation anywhere** (`loader.ts` has no `API_VERSION`/`minPiVersion`).
- Pinning exists: exact version → `pinned=true` (update-skipped); ranges honored (`getLatestNpmVersion` `:1491`, `maxSatisfying` `:1526`); git refs pinned.
- No registry in code; earendil-listed extensions = npm keyword `pi-package` + `pi.dev/packages` gallery.

### subagents (own spec set already exists)
- `specs/subagent/` — 13,984-line subsystem spec (requirements register, traceability, vendor-policy).
- Open items (20): P1 DEFECTs **REQ-L02, REQ-C02, REQ-C03, REQ-I04**; P1 GAPs **REQ-I01, REQ-I02, REQ-P02**; P2s (I03, D03-D05, CXT01, O01-O03, C04, L01, C01); P3 CANDIDATE IP01.
- `packages/agent/src` has **zero subagent code** (upstream dispatch already gone); remaining earendil ties: `docs/subagents.md:222-224` steering to npm `pi-subagents` package, upstream-era `examples/extensions/subagent/`, workspace dep names `@earendil-works/*`.
- 33 `test/subagent-*.ts` files; **no tests cover the open DEFECT/GAP rows** (grep-verified); REQ-O03 evidence likely stale (re-audit).

### compaction (screenshot errors)
- PENDING — explorer `efc25922` running. Known: "Nothing to compact (session too small)" thrown at `agent-session.ts:2245,2480`; hot-swap flow at `:1494`; uncommitted deletions of `summariser-env/-model.ts` in tree.

## Existing decisions inferred from code (marked inferred, not accepted)

- Rebrand target name **qi** is a human decision (stated 2026-10-20), not inferred.
- `[ASSUMPTION: fork-publish-rename.mjs is the intended mechanism for scope rename — rationale: it already rewrites @earendil-works/pi-* → @bramburn/pi-* at publish]`
- `[ASSUMPTION: upstream merge policy follows README.md:12-16 fork-tracking until an ADR cuts it — rationale: sync scripts still present]`

## Open questions (prioritised — Phase B)

1. **[blocking]** Rename depth: hard cut vs legacy aliases (bin/env/dirs).
2. **[blocking]** Published package scope for qi.
3. **[blocking]** Extension version-compat mechanism (manifest / range cap / mirror).
4. **[high]** Upstream endpoint cut scope (pi.dev calls).
5. **[high]** Subagent batch scope: P1 defects only vs all 20 open items.
6. **[high]** Compaction: should "session too small" surface as error vs silent skip (pending report).
7. **[low]** Fate of `specs/subagent/` conventions vs new Universal-Guide manifest (proposed: coexist; index absorbs both).

## Proposed domain split

`rebrand`, `extensions`, `subagents`, `compaction`

## Proposed spec set

| Type | Applies | Notes |
|---|---|---|
| Requirements | ✓ | one file per domain |
| ADRs | ✓ | rename strategy, cut-off policy, compat-pin strategy, compaction UX |
| Contracts | ✓ | typebox/JSON Schema: settings/env/compat-manifest shapes |
| Behavior | ✓ | bun-test bindings where they exist; else aspirational |
| UX | not_applicable (proposed) | TUI text changes only, no visual token surface |
| Impl plans | ✓ | one phase per domain |
