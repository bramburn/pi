# Bun Migration Status

Tracking Node.js → Bun migration considerations for the pi monorepo.

## Status: In Progress

This document tracks the migration of pi from Node.js to Bun (or Bun-compatible) runtime.

## Labels

- `migration:bun` - General Bun migration issue
- `blocker:bun` - Migration blocker needing attention
- `compat:bun` - Compatibility issue between Node and Bun

## Migration Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 1. Audit | Identify all Node.js-specific code | In Progress |
| 2. Test | Run all tests under Bun | Not Started |
| 3. Identify Blockers | Document blocking issues | Not Started |
| 4. Migration Plan | Write detailed migration plan | Not Started |
| 5. Implementation | Code changes for Bun support | Not Started |

## Current Status

- ✅ Bun CLI entry point exists (`packages/coding-agent/src/bun/cli.ts`)
- ✅ Release script supports Bun install (`scripts/local-release.mjs`)
- ✅ Several files check `process.versions?.bun` for Bun-specific logic
- ✅ Native module fallback for `packages/tui/src/native-modifiers.ts` (#96)
- ✅ Native module fallback for `packages/tui/src/terminal.ts` (#101)
- ✅ Bun CI workflow runs build + check on dev-bun
- ⚠️ No `bun.lock` committed
- ⚠️ Native dependencies (proper-lockfile) need validation

## See Also

- `docs/migration/state.md` - Detailed state tracking
- `docs/migration/blockers.md` - List of blocking issues
