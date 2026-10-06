# Permissions

What a child is allowed to do, and who decides.

Source: `core/sdk.ts:272-274`, `bun-process-runner.ts:101-103`, `core/project-trust.ts:25`,
`core/extensions/types.ts:138`.

---

## 1. Current model: session-scoped capability, not per-call permission

### 1.1 What exists

| Mechanism | Location |
|---|---|
| Default tool set | `core/sdk.ts:272-274` |
| Per-child tool allowlist -> `--tools` | `bun-process-runner.ts:101-103` |
| `subagent.enabled` master switch | `subagent-tool.ts:238` |
| Per-directory project trust gate | `core/project-trust.ts:25`, `main.ts:933-981` |
| Extension `confirm()` dialog | `core/extensions/types.ts:138` |

### 1.2 What does not exist

Verified absent from `packages/coding-agent/src` — no `alwaysAllow`, `alwaysDeny`, `alwaysAsk`,
no `permissionMode`, no `PreToolUse`:

| Stage | Reference design | We |
|---|---|---|
| 1. `validateInput()` before any permission check | yes | typebox schema validation exists but is argument validation, not a permission stage |
| 2. PreToolUse hooks (may approve / deny / **rewrite input**) | yes | **absent** |
| 3. Allow / Deny / Ask rules by tool-name pattern | yes | **absent** |
| 4. Interactive Allow Once / Allow Always / Deny | yes | **absent** |
| 5. `checkPermissions()` tool-specific, e.g. path sandboxing | yes | **absent** |

The project trust gate (`core/project-trust.ts:25`) gates loading project *resources and
extensions*, not tool execution. It is a trust decision at startup, not a capability decision
per call.

---

## 2. Our model is defensible — REQ-P01 (RECORD, no code)

> **Decision: do not build a full permission pipeline.** It is a product philosophy, not a
> patch. Our model is *capability grant at spawn, enforced by the process itself*: a child gets
> an explicit tool set, an explicit cwd, and an isolated process. Scope restriction is an
> explicit capability the user granted; there is no per-call approval loop to reason about.

The lighter variant of this — deriving child permissions from a parent's live ruleset object —
was already rejected in the OpenCode review. It requires reading the parent's in-process
permission state, which does not survive a process boundary.

Record this so it is not re-litigated. See [`../../rejected.md`](../../rejected.md) §4.

---

## 3. The one real hole — REQ-P02 (P1)

### 3.1 The problem

**A detached background child runs `bash` with no gate, and the user is not watching.**

With no per-call permission layer, the capability grant happens once at spawn and is never
revisited. That is fine while the parent is blocking on the child and the transcript is on
screen. It is not fine when the child is detached, may run for many minutes, and holds
`bash` + `edit` + `write` against the user's tree.

The reviewed design mitigates this accidentally: a subagent asking for something outside its
grant stops and asks. Ours cannot.

### 3.2 Requirement

| ID | Requirement |
|---|---|
| **REQ-P02.1** | Before promoting a child to `background: true`, require explicit admission: either a new `allowDetachedShell: true` input field, or a `tools` set narrowed below the default. |
| **REQ-P02.2** | The check MUST be at dispatch, alongside the `subagent.enabled` master switch (`subagent-tool.ts:238`). |
| **REQ-P02.3** | Refusal MUST be E1-class and MUST state the remedy, per [`../../components/errors.md`](../../components/errors.md). |
| **REQ-P02.4** | The tool description MUST document the admission rule so the model can set it deliberately rather than discovering it by failure. |

### 3.3 Scope discipline

This is one field and one check at one site. It is **not** a first step toward the full pipeline
in §1.2. If a future change starts adding rule tables, that is scope creep against REQ-P01.

### 3.4 Interaction

| Combined with | Effect |
|---|---|
| REQ-I01 (worktree isolation) | A detached child's blast radius is a reclaimable directory |
| REQ-X01 / REQ-X02 (real cancellation) | The operator can actually stop it |

REQ-P02 alone is thin. With REQ-I01 and REQ-X01 it is a coherent story: bounded children, each
in its own directory, each actually stoppable. That combination is the minimum defensible
configuration for detached execution.

### 3.5 Acceptance criteria

```gherkin
Scenario: Detached child requires admission
  Given a subagent call with background true
  And the default tool set
  And no explicit admission
  When the call is dispatched
  Then it MUST be refused
  And the error MUST name the admission requirement

Scenario: Narrowed detached child is admitted
  Given a subagent call with background true
  And tools narrowed to a non-shell set
  When the call is dispatched
  Then it MUST be admitted
```