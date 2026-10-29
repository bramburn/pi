# Repomix packs

## 1. OpenRouter model generation + cache model files → `repomix-output.xml`

```
node node_modules/repomix/bin/repomix.cjs --output repomix-output.xml --style xml --no-gitignore --include "packages/ai/scripts/generate-models.ts,packages/ai/scripts/openrouter-model-filter.ts,packages/ai/scripts/openrouter-reasoning-options.ts,packages/ai/scripts/model-data.ts,packages/ai/src/providers/openrouter.models.ts,packages/ai/src/providers/data/openrouter.json,packages/ai/src/providers/opencode-go.ts,packages/ai/src/model-catalog.ts,packages/ai/test/openrouter-model-filter.test.ts,packages/ai/test/openrouter-cache-control-models.test.ts,packages/ai/test/openrouter-cache-write-repro.test.ts,packages/ai/test/supports-xhigh.test.ts,packages/ai/test/xiaomi-models.test.ts,packages/ai/CHANGELOG.md"
```

14 files, ~141k tokens (`--no-gitignore` packs the gitignored `data/openrouter.json`).

## 2. Compaction analysis (model-switch 1M → 128k, chunked compaction) → `repomix-compaction.xml`

```
node node_modules/repomix/bin/repomix.cjs --output repomix-compaction.xml --style xml --include "packages/coding-agent/src/core/agent-session.ts,packages/coding-agent/src/core/session-manager.ts,packages/coding-agent/src/core/model-runtime.ts,packages/coding-agent/src/core/messages.ts,packages/coding-agent/src/core/compaction/compaction.ts,packages/coding-agent/src/core/compaction/utils.ts,packages/coding-agent/src/core/compaction/tool-result-pruner.ts,packages/coding-agent/src/core/compaction/branch-summarization.ts,packages/coding-agent/src/core/compaction/index.ts,packages/agent/src/harness/compaction/compaction.ts,packages/agent/src/harness/compaction/branch-summarization.ts,packages/ai/src/utils/estimate.ts,packages/ai/src/utils/overflow.ts,packages/coding-agent/docs/compaction.md,packages/coding-agent/test/compaction.test.ts,packages/coding-agent/test/suite/compaction-model-preference.test.ts,packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts"
```

17 files, ~103k tokens.
