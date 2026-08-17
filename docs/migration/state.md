# Bun Migration State

Detailed state tracking for the Bun migration effort.

## Last Updated
2026-08-17 04:45:00

## Last Reviewed File
packages/server/src/listener.ts (#189)

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
| 27 | packages/tui/src/fuzzy.ts | #113 | audited | Fully compatible |
| 28 | packages/tui/src/index.ts | #115 | audited | Fully compatible |
| 29 | packages/tui/src/kill-ring.ts | #117 | audited | Fully compatible |
| 30 | packages/tui/src/latex.ts | #119 | audited | Fully compatible |
| 31 | packages/tui/src/layout-node.ts | #121 | audited | Fully compatible |
| 32 | packages/tui/src/tui-alt-screen.ts | #123 | audited | Fully compatible |
| 33 | packages/tui/src/stdin-buffer.ts | #125 | audited | Fully compatible |
| 34 | packages/tui/src/terminal-colors.ts | #127 | audited | Fully compatible |
| 35 | packages/tui/src/undo-stack.ts | #129 | audited | Fully compatible |
| 36 | packages/tui/src/word-navigation.ts | #131 | audited | Fully compatible |
| 37 | packages/tui/src/components/alt-screen-flash.ts | #133 | audited | Fully compatible |
| 38 | packages/tui/src/components/box.ts | #135 | audited | Fully compatible |
| 39 | packages/tui/src/components/cancellable-loader.ts | #137 | audited | Fully compatible |
| 40 | packages/tui/src/components/h-stack.ts | #139 | audited | Fully compatible |
| 41 | packages/tui/src/components/input.ts | #141 | audited | Fully compatible |
| 42 | packages/tui/src/components/markdown.ts | #143 | audited | Fully compatible |
| 43 | packages/tui/src/components/scroll-view.ts | #145 | audited | Fully compatible |
| 44 | packages/tui/src/components/select-list.ts | #147 | audited | Fully compatible |
| 45 | packages/tui/src/components/settings-list.ts | #149 | audited | Fully compatible |
| 46 | packages/tui/src/components/spacer.ts | #151 | audited | Fully compatible |
| 47 | packages/tui/src/components/text.ts | #153 | audited | Fully compatible |
| 48 | packages/tui/src/components/truncated-text.ts | #155 | audited | Fully compatible |
| 49 | packages/tui/src/components/v-stack.ts | #157 | audited | Fully compatible |
| 50 | packages/ai/src/bedrock-provider.ts | #158 | audited | Fully compatible |
| 51 | packages/ai/src/image-models.generated.ts | #160 | audited | Fully compatible |
| 52 | packages/ai/src/images-api-registry.ts | #162 | audited | Fully compatible |
| 53 | packages/ai/src/images-models.ts | #164 | audited | Fully compatible |
| 54 | packages/ai/src/legacy-api-aliases.ts | #166 | audited | Fully compatible |
| 55 | packages/ai/src/model-catalog.ts | #168 | audited | Fully compatible |
| 56 | packages/ai/src/models-store.ts | #170 | audited | Fully compatible |
| 57 | packages/ai/src/session-resources.ts | #172 | audited | Fully compatible |
| 58 | packages/ai/src/types.ts | #174 | audited | Fully compatible |
| 59 | packages/client/src/errors.ts | #176 | audited | Fully compatible |
| 60 | packages/client/src/connection.ts | #178 | audited | Fully compatible |
| 61 | packages/client/src/promise.ts | #180 | audited | Fully compatible |
| 62 | packages/client/src/session-handle.ts | #182 | audited | Fully compatible |
| 63 | packages/client/src/transport.ts | #184 | audited | Fully compatible |
| 64 | packages/protocol/src/codec.ts | #186 | audited | Fully compatible |
| 65 | packages/protocol/src/framing.ts | #186 | audited | Fully compatible |
| 66 | packages/protocol/src/schemas.ts | #188 | audited | Fully compatible |
| 67 | packages/server/src/listener.ts | #189 | audited | Fully compatible |

## TUI Package Audit Complete

All top-level files in `packages/tui/src/*.ts` have been audited.

## Next: Components Subdirectory

The next phase is to audit `packages/tui/src/components/*.ts` files.

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