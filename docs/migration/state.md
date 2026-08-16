# Bun Migration State

Detailed state tracking for the Bun migration effort.

## Last Updated
2026-08-16 18:45:00

## Last Reviewed File
packages/tui/src/editor-component.ts (#111)

## Statistics

- Files audited: 18
- Blockers found: 1
- Compatibility issues: 1
- Issues created: 18

## Audited Files

| # | File | Issue | Status | Notes |
|---|------|-------|--------|-------|
| 1 | packages/coding-agent/src/core/auth-storage.ts | #62 | audited | Uses proper-lockfile |
| 2 | packages/coding-agent/src/config.ts | #64 | audited | Already Bun-aware |
| 3 | packages/evals/src/pi-harness.ts | #66 | audited | perf_hooks compatible |
| 4 | packages/coding-agent/src/utils/pi-user-agent.ts | #68 | audited | Already Bun-aware |
| 5 | packages/coding-agent/src/utils/image-resize.ts | #70 | audited | Worker threads need testing |
| 6 | packages/tui/src/tui.ts | #72 | audited | Fully compatible |
| 7 | packages/agent/src/harness/env/nodejs.ts | #74 | audited | Fully compatible |
| 8 | packages/ai/src/auth/oauth/load.ts | #76 | audited | Already Bun-aware |
| 9 | packages/coding-agent/src/core/trust-manager.ts | #78 | audited | Uses proper-lockfile |
| 10 | packages/ai/src/api/bedrock-converse-stream.ts | #80 | audited | Proxy agents need testing |
| 11 | packages/coding-agent/src/cli.ts | #82 | audited | Fully compatible |
| 12 | packages/server/src/server.ts | #84 | audited | Fully compatible |
| 13 | packages/telemetry/src | #86 | audited | Fully compatible |
| 14 | packages/ai/src/utils/provider-env.ts | #88 | audited | Already Bun-aware |
| 15 | packages/client/src/unix.ts | #90 | audited | Unix sockets need testing |
| 16 | packages/ai/src/bun-oauth.ts | #92 | audited | Bun-specific entry point |
| 17 | packages/ai/src/env-api-keys.ts | #94 | audited | Already Bun-aware |
| 18 | packages/tui/src/native-modifiers.ts | #96 | audited | **CRITICAL: Native modules** |
| 19 | packages/tui/src/alt-screen-search.ts | #97 | audited | Fully compatible |
| 20 | packages/tui/src/terminal-image.ts | #99 | audited | Fully compatible |
| 21 | packages/tui/src/terminal.ts | #101 | audited | **CRITICAL: Native modules** |
| 22 | packages/tui/src/tui.ts | #103 | audited | Fully compatible |
| 23 | packages/tui/src/tui-main-screen.ts | #105 | audited | Fully compatible |
| 24 | packages/tui/src/keybindings.ts | #107 | audited | Fully compatible |
| 25 | packages/tui/src/autocomplete.ts | #109 | audited | Fully compatible |
| 26 | packages/tui/src/editor-component.ts | #111 | audited | Fully compatible |

## Summary

- **Already Bun-aware:** 6 files
- **Fully compatible:** 8 files
- **Bun-specific:** 1 file
- **Needs testing:** 3 files
- **Needs attention:** 2 files (proper-lockfile)
- **Blockers:** 1 file (native modules)

## BLOCKER: Native Modules

| File | Issue | Severity |
|------|-------|----------|
| native-modifiers.ts | Loads .node modules not supported by Bun | Critical |

## Known Issues

| Issue | Files | Risk |
|-------|-------|------|
| Native modules | native-modifiers.ts | **CRITICAL** |
| proper-lockfile | auth-storage, trust-manager | Medium |
| Worker threads | image-resize | Medium |
| Proxy agents | bedrock-converse-stream | Medium |
| Unix sockets | client/unix.ts | Medium |