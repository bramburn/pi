# Bun Migration State

Detailed state tracking for the Bun migration effort.

## Last Updated
2026-08-20 18:00:00

## Last Reviewed File
packages/coding-agent/src/utils/photon.ts (#378)

## Statistics

- Files audited: 158
- Blockers found: 0
- Compatibility issues: 1
- Issues created: 18

## Audited Files

| # | File | Issue | Status | Notes |
|---|------|-------|--------|-------|
| 1 | packages/coding-agent/src/core/auth-storage.ts | #62 | RESOLVED | **Bun path: in-process lock; Node path: proper-lockfile** |
| 2 | packages/coding-agent/src/config.ts | #64 | audited | Already Bun-aware |
| 3 | packages/evals/src/pi-harness.ts | #66 | audited | perf_hooks compatible |
| 4 | packages/coding-agent/src/utils/pi-user-agent.ts | #68 | audited | Already Bun-aware |
| 5 | packages/coding-agent/src/utils/image-resize.ts | #70 | RESOLVED | **Cross-runtime URL-based Worker entrypoint; WASM in-process fallback on error** |
| 6 | packages/tui/src/tui.ts | #72 | audited | Fully compatible |
| 7 | packages/agent/src/harness/env/nodejs.ts | #74 | audited | Fully compatible |
| 8 | packages/ai/src/auth/oauth/load.ts | #76 | audited | Already Bun-aware |
| 9 | packages/coding-agent/src/core/trust-manager.ts | #78 | RESOLVED | **Bun path: in-process lock; Node path: proper-lockfile** |
| 10 | packages/ai/src/api/bedrock-converse-stream.ts | #80 | RESOLVED | **Bun path: skip proxy agent; Node path: http-proxy-agent** |
| 11 | packages/coding-agent/src/cli.ts | #82 | audited | Fully compatible |
| 12 | packages/server/src/server.ts | #84 | audited | Fully compatible |
| 13 | packages/telemetry/src | #86 | audited | Fully compatible |
| 14 | packages/ai/src/utils/provider-env.ts | #88 | audited | Already Bun-aware |
| 15 | packages/client/src/unix.ts | #90 | RESOLVED | **node:net fully implemented on Bun; drain-backpressure is callback-driven (cross-runtime safe)** |
| 16 | packages/ai/src/bun-oauth.ts | #92 | audited | Bun-specific entry point |
| 17 | packages/ai/src/env-api-keys.ts | #94 | audited | Already Bun-aware |
| 18 | packages/tui/src/native-modifiers.ts | #96 | RESOLVED | **Implemented Bun detection + graceful fallback** |
| 19 | packages/tui/src/alt-screen-search.ts | #97 | audited | Fully compatible |
| 20 | packages/tui/src/terminal-image.ts | #99 | audited | Fully compatible |
| 21 | packages/tui/src/terminal.ts | #101 | RESOLVED | **Implemented Bun detection + graceful fallback** |
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
| 35.5 | packages/tui/src/undo-stack.ts | #129 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers structuredClone clone-on-push semantics) |
| 36 | packages/tui/src/word-navigation.ts | #131 | audited | Fully compatible |
| 37 | packages/tui/src/components/alt-screen-flash.ts | #133 | audited | Fully compatible |
| 37.5 | packages/tui/src/components/alt-screen-flash.ts | #133 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers setTimeout(...).unref() + Node.js Timeout unref parity) |
| 38 | packages/tui/src/components/box.ts | #135 | audited | Fully compatible |
| 39 | packages/tui/src/components/cancellable-loader.ts | #137 | audited | Fully compatible |
| 39.5 | packages/tui/src/components/cancellable-loader.ts | #137 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers private AbortController instance-field-init per-instance identity) |
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
| 49.5 | packages/tui/src/components/v-stack.ts | #157 | audited | Fully compatible (close-out of audit track; research comment by Loop #3 + this iteration covers the Stack extends Stack pure-TS render loop) |
| 50 | packages/ai/src/bedrock-provider.ts | #158 | audited | Fully compatible |
| 50.5 | packages/ai/src/bedrock-provider.ts | #158 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers object-literal aggregation of named function imports + module-namespace reference identity) |
| 51 | packages/ai/src/image-models.generated.ts | #160 | audited | Fully compatible |
| 52 | packages/ai/src/images-api-registry.ts | #162 | audited | Fully compatible |
| 52.5 | packages/ai/src/images-api-registry.ts | #162 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers Map singleton-registry iteration order + set/get semantics) |
| 53 | packages/ai/src/images-models.ts | #164 | audited | Fully compatible |
| 54 | packages/ai/src/legacy-api-aliases.ts | #166 | audited | Fully compatible |
| 54.5 | packages/ai/src/legacy-api-aliases.ts | #166 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers ESM dynamic-import cache + deprecation-alias re-export) |
| 55 | packages/ai/src/model-catalog.ts | #168 | audited | Fully compatible |
| 56 | packages/ai/src/models-store.ts | #170 | audited | Fully compatible |
| 57 | packages/ai/src/session-resources.ts | #172 | audited | Fully compatible |
| 58 | packages/ai/src/types.ts | #174 | audited | Fully compatible |
| 59 | packages/client/src/errors.ts | #176 | audited | Fully compatible |
| 59.5 | packages/client/src/errors.ts | #176 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers toDisconnectedError identity-preservation via ECMA-262 instanceof) |
| 60 | packages/client/src/connection.ts | #178 | audited | Fully compatible |
| 60.5 | packages/client/src/connection.ts | #178 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers ServerMessageDecoder frame-decoding + maxFrameLength guard) |
| 61 | packages/client/src/promise.ts | #180 | audited | Fully compatible |
| 62 | packages/client/src/session-handle.ts | #182 | audited | Fully compatible |
| 62.5 | packages/client/src/session-handle.ts | #182 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers Symbol.asyncDispose well-known symbol parity) |
| 63 | packages/client/src/transport.ts | #184 | audited | Fully compatible |
| 63.5 | packages/client/src/transport.ts | #184 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers Uint8Array indexing parity) |
| 64 | packages/protocol/src/codec.ts | #186 | audited | Fully compatible |
| 65 | packages/protocol/src/framing.ts | #186 | audited | Fully compatible |
| 66 | packages/protocol/src/schemas.ts | #188 | audited | Fully compatible |
| 67 | packages/server/src/listener.ts | #189 | audited | Fully compatible |
| 68 | packages/server/src/sessions.ts | #190 | audited | Node.js crypto - use native |
| 69 | packages/server/src/snapshots.ts | #191 | audited | Fully compatible |
| 69.5 | packages/server/src/snapshots.ts | #191 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers chained .then().catch() promise-queue serialisation) |
| 70 | packages/evals/src/pi-harness.ts | #192 | audited | Node.js imports - test in Bun |
| 71 | packages/evals/src/extensions.eval.ts | #193 | RESOLVED | **vitest pool pinned to forks (Bun-safe); bun x vitest in README** |
| 72 | packages/evals/src/smoke.eval.ts | #194 | audited | Needs vitest |
| 73 | packages/telemetry/src/memory.ts | #195 | audited | Fully compatible |
| 74 | packages/telemetry/src/noop.ts | #196 | audited | Fully compatible |
| 75 | packages/coding-agent/src/bun/register-bedrock.ts | #198 | audited | Fully compatible |
| 75.5 | packages/coding-agent/src/bun/register-bedrock.ts | #198 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers Bun-specific entry chunk + npm exports subpath resolution) |
| 76 | packages/coding-agent/src/bun/restore-sandbox-env.ts | #199 | audited | Bun-specific workaround |
| 77 | packages/coding-agent/src/cli/args.ts | #200 | audited | Fully compatible |
| 78 | packages/coding-agent/src/cli/auth-check.ts | #202 | audited | Fully compatible |
| 78.5 | packages/coding-agent/src/cli/auth-check.ts | #202 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers try/await/catch microtask scheduling) |
| 79 | packages/coding-agent/src/cli/auth-command.ts | #204 | audited | Fully compatible |
| 79.5 | packages/coding-agent/src/cli/auth-command.ts | #204 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers regex /iu flag parity) |
| 80 | packages/coding-agent/src/cli/config-selector.ts | #206 | audited | Fully compatible |
| 81 | packages/coding-agent/src/cli/credential-print.ts | #208 | audited | Fully compatible |
| 81.5 | packages/coding-agent/src/cli/credential-print.ts | #208 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers cliModel! + conditional object spread) |
| 82 | packages/coding-agent/src/cli/experimental/command-options.ts | #210 | audited | Fully compatible |
| 82.5 | packages/coding-agent/src/cli/experimental/command-options.ts | #210 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 83 | packages/coding-agent/src/cli/experimental/transport-address.ts | #212 | audited | Fully compatible |
| 84 | packages/coding-agent/src/cli/file-processor.ts | #214 | audited | Fully compatible |
| 84.5 | packages/coding-agent/src/cli/file-processor.ts | #214 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers chalk v5 ANSI parity + stderr-flush order) |
| 85 | packages/coding-agent/src/cli/initial-message.ts | #216 | audited | Fully compatible |
| 86 | packages/coding-agent/src/cli/list-models.ts | #218 | audited | Fully compatible |
| 87 | packages/coding-agent/src/cli/project-trust.ts | #220 | audited | Fully compatible |
| 88 | packages/coding-agent/src/cli/session-picker.ts | #222 | audited | Fully compatible |
| 89 | packages/coding-agent/src/cli/startup-ui.ts | #224 | audited | Fully compatible |
| 89.5 | packages/coding-agent/src/cli/startup-ui.ts | #224 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers bare-fs specifier resolution) |
| 90 | packages/coding-agent/src/client/remote-session.ts | #226 | audited | Fully compatible |
| 91 | packages/coding-agent/src/client/transcript.ts | #228 | audited | Fully compatible |
| 91.5 | packages/coding-agent/src/client/transcript.ts | #228 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers structuredClone parity) |
| 92 | packages/coding-agent/src/core/agent-session-runtime.ts | #230 | audited | Fully compatible |
| 93 | packages/coding-agent/src/core/agent-session-services.ts | #232 | audited | Fully compatible |
| 93.5 | packages/coding-agent/src/core/agent-session-services.ts | #232 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 94 | packages/coding-agent/src/core/auth-guidance.ts | #234 | audited | Fully compatible |
| 95 | packages/coding-agent/src/core/bash-executor.ts | #236 | audited | Fully compatible |
| 96 | packages/coding-agent/src/core/cache-stats.ts | #238 | audited | Fully compatible |
| 97 | packages/coding-agent/src/core/compaction/branch-summarization.ts | #240 | audited | Fully compatible |
| 98 | packages/coding-agent/src/core/defaults.ts | #242 | audited | Fully compatible |
| 99 | packages/coding-agent/src/core/diagnostics.ts | #244 | audited | Fully compatible |
| 100 | packages/coding-agent/src/core/event-bus.ts | #245 | audited | Fully compatible |
| 100.5 | packages/coding-agent/src/core/event-bus.ts | #245 | audited | Fully compatible (close-out of audit track; research comment by Loop #6; duplicate-audit row created by parallel Loop #4 / Loop #6 run while #298 was closing) |
| 101 | packages/coding-agent/src/core/export-html/ansi-to-html.ts | #247 | audited | Fully compatible |
| 102 | packages/coding-agent/src/core/export-html/tool-renderer.ts | #249 | audited | Fully compatible |
| 103 | packages/coding-agent/src/core/extensions/runner.ts | #251 | audited | Fully compatible |
| 104 | packages/coding-agent/src/core/extensions/wrapper.ts | #253 | audited | Fully compatible |
| 105 | packages/coding-agent/src/core/footer-data-provider.ts | #255 | RESOLVED | **Bun: stronger watchFile dedup via persistent mtime/size signature** |
| 105.5 | packages/coding-agent/src/core/extensions/wrapper.ts | #253 | audited | Fully compatible (close-out of audit track) |
| 106 | packages/coding-agent/src/core/http-dispatcher.ts | #257 | RESOLVED | **Bun path: skip undici.setGlobalDispatcher; Node path: full undici install** |
| 107 | packages/coding-agent/src/core/messages.ts | #259 | audited | Fully compatible |
| 108 | packages/coding-agent/src/core/model-config.ts | #261 | audited | Fully compatible |
| 109 | packages/coding-agent/src/core/model-registry.ts | #263 | audited | Fully compatible |
| 110 | packages/coding-agent/src/core/model-resolver.ts | #265 | audited | Fully compatible (close-out of audit track) |
| 110.5 | packages/coding-agent/src/core/model-registry.ts | #263 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 111 | packages/coding-agent/src/core/model-runtime.ts | #267 | audited | Fully compatible (close-out of audit track) |
| 112 | packages/coding-agent/src/core/output-guard.ts | #269 | audited | Fully compatible (close-out of audit track) |
| 113 | packages/coding-agent/src/core/package-manager.ts | #271 | audited | Fully compatible (close-out of audit track) |
| 114 | packages/coding-agent/src/core/pi-manifest.ts | #273 | audited | Fully compatible (close-out of audit track) |
| 115 | packages/coding-agent/src/core/prompt-templates.ts | #275 | audited | Fully compatible (close-out of audit track) |
| 116 | packages/coding-agent/src/core/provider-attribution.ts | #277 | audited | Fully compatible (close-out of audit track) |
| 117 | packages/coding-agent/src/core/provider-composer.ts | #279 | audited | Fully compatible (close-out of audit track) |
| 118 | packages/coding-agent/src/core/radius.ts | #281 | audited | Fully compatible (close-out of audit track) |
| 119 | packages/coding-agent/src/core/remote-catalog-provider.ts | #283 | audited | Fully compatible (close-out of audit track) |
| 120 | packages/coding-agent/src/core/resolve-config-value.ts | #285 | audited | Fully compatible (no migration work; close-out of audit track) |
| 121 | packages/tui/src/components/editor.ts | #286 | audited | Fully compatible |
| 121.5 | packages/tui/src/components/editor.ts | #286 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 122 | packages/tui/src/components/image.ts | #288 | audited | Fully compatible |
| 123 | packages/tui/src/components/loader.ts | #290 | audited | Fully compatible |
| 124 | packages/tui/src/components/stack.ts | #292 | audited | Fully compatible |
| 125 | packages/coding-agent/src/core/resource-loader.ts | #294 | audited | Fully compatible |
| 126 | packages/coding-agent/src/core/extensions/loader.ts | #296 | audited | Fully compatible (jiti uses createRequire which Bun supports) |
| 127 | packages/coding-agent/src/core/event-bus.ts | #298 | audited | Fully compatible |
| 127.5 | packages/coding-agent/src/core/event-bus.ts | #298 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 128 | packages/coding-agent/src/core/diagnostics.ts | #300 | audited | Fully compatible (type-declaration module) |
| 129 | packages/coding-agent/src/migrations.ts | #302 | audited | Fully compatible |
| 130 | packages/coding-agent/src/core/auth-guidance.ts | #304 | audited | Fully compatible |
| 131 | packages/coding-agent/src/cli/initial-message.ts | #306 | audited | Fully compatible |
| 132 | packages/coding-agent/src/client/transcript.ts | #308 | audited | Fully compatible |
| 133 | packages/coding-agent/src/cli/file-processor.ts | #311 | audited | Fully compatible |
| 133.5 | packages/coding-agent/src/cli/file-processor.ts | #311 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 134 | packages/coding-agent/src/cli/args.ts | #312 | audited | Fully compatible |
| 134.5 | packages/coding-agent/src/cli/args.ts | #312 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 135 | packages/coding-agent/src/cli/auth-check.ts | #314 | audited | Fully compatible |
| 135.5 | packages/coding-agent/src/cli/auth-check.ts | #314 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 136 | packages/coding-agent/src/cli/auth-command.ts | #316 | audited | Fully compatible |
| 136.5 | packages/coding-agent/src/cli/auth-command.ts | #316 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 137 | packages/coding-agent/src/cli/credential-print.ts | #318 | audited | Fully compatible |
| 137.5 | packages/coding-agent/src/cli/credential-print.ts | #318 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 138 | packages/coding-agent/src/cli/config-selector.ts | #320 | audited | Fully compatible |
| 139 | packages/coding-agent/src/cli/experimental/command.ts | #322 | audited | Fully compatible |
| 140 | packages/coding-agent/src/cli/experimental/command-options.ts | #324 | audited | Fully compatible |
| 141 | packages/coding-agent/src/cli/experimental/transport-address.ts | #327 | audited | Fully compatible |
| 142 | packages/coding-agent/src/cli/experimental/commands/client.ts | #330 | audited | Fully compatible |
| 143 | packages/coding-agent/src/cli/experimental/commands/pi.ts | #333 | audited | Fully compatible |
| 144 | packages/coding-agent/src/utils/child-process.ts | #336 | audited | Fully compatible |
| 145 | packages/coding-agent/src/utils/ansi.ts | #339 | audited | Fully compatible |
| 146 | packages/coding-agent/src/utils/abort.ts | #342 | audited | Fully compatible |
| 147 | packages/coding-agent/src/utils/changelog.ts | #345 | audited | Fully compatible |
| 148 | packages/coding-agent/src/utils/clipboard-image.ts | #348 | audited | Fully compatible |
| 149 | packages/coding-agent/src/utils/clipboard.ts | #351 | audited | Fully compatible |
| 150 | packages/coding-agent/src/utils/clipboard-native.ts | #354 | audited | Fully compatible |
| 151 | packages/coding-agent/src/utils/deprecation.ts | #357 | audited | Fully compatible |
| 152 | packages/coding-agent/src/utils/exif-orientation.ts | #360 | audited | Fully compatible |
| 154 | packages/coding-agent/src/core/extensions/index.ts | #365 | audited | Fully compatible |
| 154.5 | packages/coding-agent/src/core/extensions/index.ts | #365 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers class re-export prototype-chain identity) |
| 153 | packages/coding-agent/src/utils/frontmatter.ts | #363 | audited | Fully compatible |
| 154 | packages/coding-agent/src/utils/image-resize.ts | #366 | audited | Fully compatible |
| 155 | packages/coding-agent/src/utils/image-resize-core.ts | #369 | audited | Fully compatible |
| 156 | packages/coding-agent/src/utils/mime.ts | #372 | audited | Fully compatible |
| 157 | packages/coding-agent/src/utils/paths.ts | #375 | audited | Fully compatible |
| 158 | packages/coding-agent/src/utils/photon.ts | #378 | audited | Fully compatible |
| 158 | packages/coding-agent/src/core/models-store.ts | #377 | audited | Fully compatible |
| 158.5 | packages/coding-agent/src/core/models-store.ts | #377 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers signal.throwIfAborted() + raceWithAbortSignal integration) |
| 157 | packages/coding-agent/src/core/keybindings.ts | #374 | audited | Fully compatible |
| 157.5 | packages/coding-agent/src/core/keybindings.ts | #374 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers try/catch graceful-degradation around readFileSync + JSON.parse) |
| 155.5 | packages/coding-agent/src/utils/image-resize-core.ts | #369 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers Buffer.from(uint8Array).toString(base64) + Buffer.byteLength parity) |
| 156 | packages/coding-agent/src/core/index.ts | #371 | audited | Fully compatible |
| 156.5 | packages/coding-agent/src/core/index.ts | #371 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers per-binding re-export live-binding identity) |
| 155 | packages/coding-agent/src/core/extensions/types.ts | #368 | audited | Fully compatible (type-only; 1728-line file) |
| 155.5 | packages/coding-agent/src/core/extensions/types.ts | #368 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers typebox Static<TSchema> conditional-type derivation) |
| 153 | packages/coding-agent/src/core/export-html/index.ts | #362 | audited | Fully compatible |
| 153.5 | packages/coding-agent/src/core/export-html/index.ts | #362 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers hex/rgb regex parseColor match-group parity) |
| 152 | packages/coding-agent/src/core/experimental.ts | #359 | audited | Fully compatible |
| 152.5 | packages/coding-agent/src/core/experimental.ts | #359 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers process.env indexing parity) |
| 150.5 | packages/coding-agent/src/utils/clipboard-native.ts | #354 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers Node-API native module + createRequire semantics + graceful-degradation path) |
| 151 | packages/coding-agent/src/core/exec.ts | #356 | audited | Fully compatible |
| 151.5 | packages/coding-agent/src/core/exec.ts | #356 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers stdout/stderr Buffer chunk streaming) |
| 146.5 | packages/coding-agent/src/utils/abort.ts | #342 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 147 | packages/coding-agent/src/core/agent-session.ts | #344 | audited | Fully compatible (surface-level audit; 3,344-line file, node:fs + node:path + process.cwd only) |
| 148 | packages/coding-agent/src/core/compaction/compaction.ts | #347 | audited | Fully compatible (surface-level audit; 969-line pure-TS file, no node:* or process.* imports) |
| 149 | packages/coding-agent/src/core/compaction/index.ts | #350 | audited | Fully compatible |
| 150 | packages/coding-agent/src/core/compaction/utils.ts | #353 | audited | Fully compatible |
| 150.5 | packages/coding-agent/src/core/compaction/utils.ts | #353 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers Set.prototype.add + for..of ordering) |
| 149.5 | packages/coding-agent/src/core/compaction/index.ts | #350 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers wildcard re-export binding identity) |
| 148.5 | packages/coding-agent/src/core/compaction/compaction.ts | #347 | audited | Fully compatible (close-out of audit track; research comment by Loop #6 covers async-retry microtask semantics) |
| 147.5 | packages/coding-agent/src/core/agent-session.ts | #344 | audited | Fully compatible (close-out of audit track; research comment by Loop #6; deep-read of exportToJsonl block confirms only the audited surfaces) |
| 146 | packages/coding-agent/src/client/index.ts | #341 | audited | Fully compatible |
| 146.5 | packages/coding-agent/src/client/index.ts | #341 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 145.5 | packages/coding-agent/src/utils/ansi.ts | #339 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 144.5 | packages/coding-agent/src/utils/child-process.ts | #336 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 145 | packages/coding-agent/src/bun/cli.ts | #338 | audited | Bun-specific entry point (Bun-only chain) |
| 145.5 | packages/coding-agent/src/bun/cli.ts | #338 | audited | Bun-specific entry point (close-out of audit track; research comment by Loop #6) |
| 142.5 | packages/coding-agent/src/cli/experimental/commands/client.ts | #330 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 141.5 | packages/coding-agent/src/cli/experimental/transport-address.ts | #327 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 142 | packages/coding-agent/src/cli/experimental/auth.ts | #329 | audited | Fully compatible |
| 143 | packages/coding-agent/src/cli/experimental/commands/pi.ts | #332 | audited | Fully compatible |
| 144 | packages/coding-agent/src/cli/experimental/commands/server.ts | #335 | audited | Fully compatible |
| 144.5 | packages/coding-agent/src/cli/experimental/commands/server.ts | #335 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 143.5 | packages/coding-agent/src/cli/experimental/commands/pi.ts | #332 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 143.6 | packages/coding-agent/src/cli/experimental/commands/pi.ts | #333 | audited | Fully compatible (close-out of audit track; research comment by Loop #6; duplicate-audit row created by parallel Loop #4 run while #332 was closing) |
| 142.5 | packages/coding-agent/src/cli/experimental/auth.ts | #329 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 140.5 | packages/coding-agent/src/cli/experimental/command-options.ts | #324 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 141 | packages/coding-agent/src/cli/experimental/cli.ts | #326 | audited | Fully compatible |
| 141.5 | packages/coding-agent/src/cli/experimental/cli.ts | #326 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 138.5 | packages/coding-agent/src/cli/config-selector.ts | #320 | audited | Fully compatible (close-out of audit track; research comment by Loop #6) |
| 132.5 | packages/coding-agent/src/cli/list-models.ts | #218 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 131.5 | packages/coding-agent/src/client/remote-session.ts | #226 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 130.5 | packages/coding-agent/src/cli/project-trust.ts | #220 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 130.6 | packages/coding-agent/src/cli/session-picker.ts | #222 | audited | Fully compatible (close-out of audit track) |
| 129.5 | packages/coding-agent/src/core/cache-stats.ts | #238 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 128.5 | packages/coding-agent/src/core/compaction/branch-summarization.ts | #240 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 128.6 | packages/coding-agent/src/core/defaults.ts | #242 | audited | Fully compatible (close-out of audit track) |
| 127.5 | packages/coding-agent/src/core/bash-executor.ts | #236 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 126.5 | packages/coding-agent/src/core/export-html/tool-renderer.ts | #249 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 126.6 | packages/coding-agent/src/core/export-html/ansi-to-html.ts | #247 | audited | Fully compatible (close-out of audit track) |
| 125.5 | packages/coding-agent/src/core/extensions/runner.ts | #251 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 123 | packages/coding-agent/src/core/model-config.ts | #261 | audited | Fully compatible (close-out of audit track; research comment by Loop #3) |
| 124 | packages/coding-agent/src/core/messages.ts | #259 | audited | Fully compatible (close-out of audit track) |

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
| native-modifiers.ts | Loads .node modules not supported by Bun | Critical | ✅ Resolved |
| terminal.ts | Loads .node modules not supported by Bun | Critical | ✅ Resolved |

## Known Issues

| Issue | Files | Risk | Status |
|-------|-------|------|--------|
| Native modules | native-modifiers.ts | **CRITICAL** | ✅ Graceful fallback implemented |
| Native modules | terminal.ts | **CRITICAL** | ✅ Graceful fallback implemented |
| proper-lockfile | auth-storage | Medium | ✅ Resolved (Bun → in-process lock) |
| proper-lockfile | trust-manager | Medium | ✅ Resolved (Bun → in-process lock) |
| Worker threads | image-resize | Medium | ✅ Resolved (URL entrypoint cross-runtime) |
| fs.watchFile firing | footer-data-provider | Medium | ✅ Resolved (mtime/size dedup) |
| Proxy agents | bedrock-converse-stream | Medium | ✅ Resolved (Bun → native HTTP) |
| Unix sockets | client/unix.ts | Medium | ✅ Resolved (Bun implements node:net) |