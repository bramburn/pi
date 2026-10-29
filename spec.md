# Universal Spec Guidance for Spec-Driven Development

> **How to use this document.** This is a playbook for an AI agent (and the human supervising it) to produce specs that are *discussable*, *finalisable*, and *batch-consumable*. It is stack-agnostic in its principles and stack-specific in its appendices. It assumes the specs will be handed to `batch-review` (or any equivalent multi-task batch system) alongside relevant code context, and must therefore be **addressable** — one concept per file, indexed by a manifest, with stable IDs.

---

## 0. Purpose and non-goals

**Purpose.** Produce a spec set that is:

1. **Discussed, not asserted.** No silent assumptions. Every ambiguity is surfaced, recommended, and either confirmed or rejected before finalisation.
2. **Addressable.** Every spec unit lives in its own file, has a stable ID, and declares what it governs.
3. **Batch-ready.** Any task's context can be derived mechanically from the manifest, without manual curation.
4. **Traceable.** Every requirement → contract → behavior → test → batch finding has a link.
5. **Implementation-agnostic until agreed.** Requirements say *what*, contracts say *boundary*, impl plans say *how*. These never bleed into each other before finalisation.

**Non-goals.**

- This is not a template library. Templates exist inside the writing rules (Section 5).
- This is not a workflow tool. The agent uses its own tools; this guide defines *what* to produce and *in what order*.
- This is not a substitute for the human's judgment. The agent's recommendations are proposals, not decisions.

---

## 1. Core principles

| # | Principle | Consequence if violated |
|---|---|---|
| P1 | **One concept per file.** | Files become unaddressable for batch context; can't be pulled individually. |
| P2 | **No silent assumptions.** | Final specs contain invented behavior; code and tests fail to match. |
| P3 | **Recommendations, not questions.** | Humans can't process 40 open questions; decisions stall. |
| P4 | **Requirements do not name technologies.** | Specs become irrelevant when the stack changes or is swapped mid-project. |
| P5 | **Contracts are executable or machine-checked.** | Contracts rot; nothing catches drift between spec and code. |
| P6 | **Every spec has an owner domain.** | Batch context selection can't scope by domain; tasks bleed into each other. |
| P7 | **ADRs are immutable once accepted.** | History is lost; reviewers can't reconstruct why a decision was made. |
| P8 | **Behavior specs are runnable or explicitly aspirational.** | Gherkin becomes documentation theatre. |
| P9 | **Greenfield and brownfield are declared, not inferred at review time.** | Specs claim "current state" that was never verified, or claim "target state" that was already implemented. |
| P10 | **The manifest is the single index.** | Batch cannot find specs; humans can't find specs; both give up. |

---

## 2. Document taxonomy

Every project, regardless of stack, produces from these six document types. If a type is genuinely inapplicable, record that in the manifest as `"not_applicable": "<reason>"` — do not silently omit.

| Type | Answers | Machine-readable? | Lives in | Produced by |
|---|---|---|---|---|
| **Requirements** | *What must the system do?* | Partially (IDs + acceptance criteria) | `specs/00-requirements/` | Agent + human |
| **ADRs** | *Why was decision X made?* | No (prose + checklist) | `specs/adr/` | Agent + human |
| **Contracts** | *What is the exact interface?* | Yes | `specs/contracts/` | Agent (finalised by human) |
| **Behavior specs** | *How does it behave under what conditions?* | Yes (Gherkin) | `specs/features/` | Agent + human |
| **UX specs** | *What does it look/feel like?* | Partially (design tokens = JSON; screens = MD) | `specs/ux/` | Human + agent |
| **Impl plans** | *In what order will this be built and verified?* | Partially (DAG) | `specs/impl/` | Agent (finalised by human) |

**Which types apply to which stack:**

| Stack | Requirements | ADRs | Contracts | Behavior | UX | Impl |
|---|---|---|---|---|---|---|
| Flutter / Dart | ✓ | ✓ | Pigeon, JSON Schema | Gherkin → `flutter test` | Design tokens + screen specs | ✓ |
| .NET / C# | ✓ | ✓ | `.proto`, OpenAPI, JSON Schema | Gherkin → Reqnroll | XAML/MAUI specs (if UI) | ✓ |
| Next.js / TS | ✓ | ✓ | OpenAPI, tRPC types, Zod | Playwright / Gherkin | Design tokens + route specs | ✓ |
| Python | ✓ | ✓ | OpenAPI, Pydantic | Gherkin → pytest-bdd | Rare (unless Streamlit/Textual) | ✓ |
| Rust / Tauri | ✓ | ✓ | `#[tauri::command]` + specta, `.proto` | Gherkin → cucumber-rs | Frontend (see Next.js/Flutter) | ✓ |

---

## 3. Universal document structure

### 3.1 The manifest — `specs/manifest.json`

**Every project has exactly one manifest.** It is the index the batch tool reads, the human browses, and the agent maintains.

```jsonc
{
  "version": "1.0",
  "mode": "brownfield",            // "brownfield" | "greenfield" | "hybrid"
  "stack": ["flutter"],            // from Section 8 detection
  "domains": ["quiz", "billing", "onboarding", "settings", "core", "ux"],

  "specs": [
    {
      "id": "REQ-QUIZ-001",
      "type": "requirements",
      "domain": "quiz",
      "path": "00-requirements/features/quiz-requirements.md",
      "title": "Quiz practice session",
      "status": "accepted",        // draft | proposed | accepted | superseded
      "depends_on": [],
      "governs": ["mobile-app/lib/src/features/quiz/**"],
      "verifies": []
    },
    {
      "id": "ADR-0002",
      "type": "adr",
      "domain": "core",
      "path": "adr/0002-dual-database-architecture.md",
      "title": "Dual database architecture",
      "status": "accepted",
      "depends_on": ["ADR-0001"],
      "governs": ["mobile-app/lib/src/core/db/**"],
      "verifies": []
    },
    {
      "id": "BEHAV-QUIZ-ANSWER-RECORDING",
      "type": "behavior",
      "domain": "quiz",
      "path": "features/quiz/answer-recording.feature",
      "title": "Answer recording invariants",
      "status": "accepted",
      "depends_on": ["REQ-QUIZ-005"],
      "governs": [],
      "verifies": ["mobile-app/test/features/quiz/answer_recording_test.dart"]
    },
    {
      "id": "CONTRACT-MODEL-USER-ANSWER",
      "type": "contract",
      "domain": "quiz",
      "path": "contracts/json-schema/user-answer-result.schema.json",
      "title": "UserAnswerResult",
      "status": "accepted",
      "depends_on": ["REQ-QUIZ-005"],
      "governs": ["mobile-app/lib/src/features/quiz/domain/models/"],
      "verifies": []
    }
  ]
}
```

**Field rules:**

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable. Format: `{TYPE}-{DOMAIN}-{NNN}` or `{TYPE}-{DOMAIN}-{SLUG}`. Never reused. |
| `type` | yes | One of `requirements`, `adr`, `contract`, `behavior`, `ux`, `impl`. |
| `domain` | yes | Must be in `domains` array. |
| `path` | yes | Relative to `specs/`. |
| `status` | yes | `draft` / `proposed` / `accepted` / `superseded`. Only `accepted` and `superseded` may be referenced by `depends_on`. |
| `depends_on` | yes (may be `[]`) | Spec IDs that must be read first. Enables greenfield ordering. |
| `governs` | required for `requirements`, `adr`, `contract`, `ux`, `impl` | Glob paths, relative to repo root, that this spec constrains. Drives brownfield batch context. |
| `verifies` | required for `behavior` | Test files that bind this spec. Drives "is this spec actually enforced?" checks. |

### 3.2 ID conventions

| Type prefix | Example |
|---|---|
| `REQ-` | `REQ-BILLING-003` |
| `ADR-` | `ADR-0007` (four digits, monotonically increasing) |
| `CONTRACT-` | `CONTRACT-API-PROJECT-CREATE` |
| `BEHAV-` | `BEHAV-CHECKOUT-PAYMENT-DECLINE` |
| `UX-` | `UX-SCREEN-QUIZ` |
| `IMPL-` | `IMPL-PHASE-002` |

IDs are **never** reused, never renumbered, never renamed. If a spec is superseded, the new one takes the next number and both remain in the manifest with `status: superseded` on the old one.

### 3.3 File sizing

Size limits exist for addressability. A file too large cannot be handed to a batch task without blowing the context budget.

| Type | Max lines | Max tokens (approx) |
|---|---|---|
| Requirements (per domain) | 500 | ~2,000 |
| ADR (per decision) | 100 | ~400 |
| Contract (per interface) | 300 | ~1,200 |
| Behavior feature (per capability) | 200 | ~800 |
| UX screen spec | 300 | ~1,200 |
| Impl plan | 400 | ~1,600 |

If a file exceeds its limit, split it. Never compress to fit — split.

### 3.4 Naming

- Files: `kebab-case.md`, `kebab-case.feature`, `kebab-case.schema.json`, `kebab-case.proto`.
- ADRs: `{NNNN}-{short-title}.md`.
- Requirements: `{domain}-requirements.md` — one per domain.
- Behavior: `{capability}.feature` — one per capability, not per domain.
- No spaces, no uppercase, no dates in filenames (dates live in manifest if needed).

---

## 4. The authoring protocol

This is the heart of the guide. **The agent must not skip phases.** Each phase has entry and exit criteria.

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐
│  A.      │──▶│  B.      │──▶│  C.      │──▶│  D.      │──▶│  E.       │
│ Context  │   │ Clarify  │   │  Draft   │   │ Resolve  │   │ Finalise  │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └───────────┘
                     ▲              │              │
                     └──────────────┴──────────────┘
                        (iterate until zero markers)
```

### Phase A — Contextualise

**Entry:** human asks for specs on a repo, a feature, or a greenfield project.

**Steps the agent performs:**

1. **Detect mode.**
   - `greenfield` if: source tree is empty or contains only scaffolding, no tests, no git history beyond init.
   - `brownfield` if: source tree has substantive code and tests.
   - `hybrid` if: some domains exist, others don't. Record per-domain in the manifest.

2. **Detect stack(s).** Signals, in order of precedence:

   | Stack | Primary signal | Secondary signal |
   |---|---|---|
   | Flutter | `pubspec.yaml` with `flutter:` dependency | `lib/main.dart`, `mobile-app/`, `app/` |
   | .NET | `*.csproj` or `*.sln` at repo root or in `src/` | `Program.cs`, `Startup.cs`, `appsettings.json` |
   | Next.js | `package.json` with `"next"` in deps | `next.config.*`, `app/` or `pages/` |
   | Python | `pyproject.toml` or `requirements.txt` | `src/*.py`, `__init__.py`, `setup.py` |
   | Rust | `Cargo.toml` with `[package]` | `src/main.rs`, `src/lib.rs` |
   | Tauri | `tauri.conf.json` + `src-tauri/` | Rust in `src-tauri/src/` |

   A repo may have multiple stacks (e.g. Tauri = Rust + frontend, Next.js). Record all; each manifest entry declares its `stack`.

3. **Inventory existing specs.** If `specs/` exists, read the manifest and every spec listed. If it doesn't, create `specs/manifest.json` with `mode`, `stack`, `domains: []`.

4. **Read code (brownfield) or requirements source (greenfield).**
   - Brownfield: read entry points, top-level structure, CI config, test layout. Do **not** read every file. Produce a *structural map* (directories → purpose → key files).
   - Greenfield: read whatever prompt, brief, or external doc the human provided. If there is none, **stop and ask** — a greenfield spec with no requirements source is fiction.

5. **Produce a Context Brief** (≤1 page, Markdown, saved to `specs/.draft/context-brief.md`):
   - Mode, stack(s), domains
   - What exists (brownfield) / what is being created (greenfield)
   - Existing decisions inferred from code (e.g. "uses Drift, not sqflite" — mark as inferred, not accepted)
   - **Open questions this phase could not answer** (numbered, prioritised — see Phase B for format)
   - Proposed domain split
   - Proposed spec set (which of the six types apply)

**Exit:** human reads the Context Brief and confirms (or corrects) mode, stack, domains, and proposed spec set.

### Phase B — Clarify

**Entry:** Context Brief accepted.

**Steps:**

1. **Enumerate every decision the spec set requires.** A decision is any statement in a spec that could reasonably be different. Examples: "what happens when the payment times out?", "should the API paginate?", "is this cached?".

2. **Classify each decision:**
   - **Blocking** — cannot write the spec without it.
   - **High-impact** — affects multiple spec types, hard to change later.
   - **Low-impact** — local, easily changed.
   - **Assumed** — agent has strong evidence from code or docs; will become an explicit assumption in Phase C but doesn't need a question.

3. **Batch questions.** Rules:
   - **Maximum 7 questions per round.** Beyond that, humans can't process them.
   - **One round per spec type**, in order: requirements → contracts → behavior → UX → impl. ADRs are written during the phase their decision emerges (often Phase B or D).
   - **Sort by class:** blocking first, then high-impact, then low-impact.
   - **Every question has the structure below.**

4. **Question format (mandatory):**

   ```markdown
   ### Q3 — Payment timeout behavior
   **Blocks:** CONTRACT-API-CHECKOUT, BEHAV-CHECKOUT-PAYMENT-DECLINE
   **Class:** blocking
   **Question:** What should the checkout API return when the upstream payment provider times out after 30 seconds?
   **Options:**
     (a) HTTP 504 Gateway Timeout with `Retry-After: 60`
     (b) HTTP 202 Accepted + async status polling
     (c) HTTP 409 Conflict, treat as idempotency failure
   **Recommendation:** (a). Reason: upstream provider is the point of failure; retries are safe because the idempotency key is already captured; clients already handle 5xx.
   **Cost if wrong:** HIGH — changing this later requires a version bump of the checkout endpoint and client changes.
   **Evidence:** `src/checkout/gateway.py:142` already catches `TimeoutError` and logs but does not return a specific code.
   ```

5. **Do not proceed to Phase C until every blocking question is answered.** For high-impact questions unanswered by the time the human signals "proceed", convert them to explicit `[ASSUMPTION: <choice> — rationale: <...>]` markers in Phase C and flag them prominently in Phase D.

**Exit:** all blocking questions answered; ≤3 high-impact questions deferred to Phase D with human's explicit acknowledgement.

### Phase C — Draft with markers

**Entry:** Phase B exit criteria met.

**Steps:**

1. **Write every spec in draft form** following the writing rules in Section 5.

2. **Every draft contains exactly two marker types**, both uppercase, both greppable:

   - `[ASSUMPTION: <claim> — rationale: <evidence>]` — something the agent inferred from code, docs, or a deferred Phase B question.
   - `[UNRESOLVED: <open question> — suggested: <choice>]` — something the agent could not resolve and cannot assume.

3. **Every draft ends with a `## Traceability` section** listing:

   - Requirements IDs this document realises (for `contract`, `behavior`, `impl`).
   - ADR IDs this document depends on.
   - Other specs this document references.
   - (Empty sections are still present.)

4. **Update the manifest** with every draft spec at `status: "draft"`.

5. **Do not write any final prose.** No polished executive summaries. No closing remarks. Drafts are deliberately dry.

**Exit:** every spec file listed in the manifest exists as `draft`; every file is within size limits; every `[ASSUMPTION]` and `[UNRESOLVED]` marker is present.

### Phase D — Resolve

**Entry:** Phase C exit criteria met.

**Steps:**

1. **Produce a Resolution Document** (saved to `specs/.draft/resolution.md`). It contains:

   - **Every `[ASSUMPTION]`** as a numbered item, with: the claim, the evidence, and a recommendation to accept or reject.
   - **Every `[UNRESOLVED]`** as a numbered question, structured exactly as in Phase B.

2. **Group by document type**, not by spec file. This lets the human think about one kind of decision at a time.

3. **Handle each resolution:**
   - Accepted assumption → becomes a fact in the final spec; if it warrants an ADR (i.e. it's an architectural decision), an ADR is drafted and added to the manifest.
   - Rejected assumption → the spec is edited to match the human's correction; if the rejection reveals a new ambiguity, it becomes an `[UNRESOLVED]` in the next round.
   - Resolved `[UNRESOLVED]` → the answer is applied to the spec.
   - Deferred `[UNRESOLVED]` (human says "leave it") → the spec is edited to remove the marker and note "not specified" in a `## Known Gaps` section, and the manifest entry gets `"status": "accepted_with_gaps"`.

4. **Iterate** until zero markers remain across all draft specs.

**Exit:** `specs/.draft/resolution.md` shows every marker resolved; zero `[ASSUMPTION]` or `[UNRESOLVED]` strings remain in any spec file.

### Phase E — Finalise

**Entry:** Phase D exit criteria met.

**Steps:**

1. **Strip markers.** Remove `[ASSUMPTION]` and `[UNRESOLVED]` strings from all files.

2. **Promote status.** Change every spec in the manifest from `draft` to `accepted` (or `accepted_with_gaps`).

3. **Run the Quality Gates** (Section 9). Fix failures; do not suppress them.

4. **Archive the drafts.** Move `specs/.draft/` to `specs/.history/{ISO-date}/`. History is retained but not scanned by batch tools (add to `.gitignore` if size is a concern).

5. **Produce a Spec Index** (`specs/README.md`) containing:
   - The domain list
   - The spec count per type
   - The 5 most recently accepted ADRs
   - A "how to use this in batch" section pointing at the manifest

**Exit:** All quality gates pass; `specs/README.md` reflects the final state; `specs/manifest.json` is the only source of truth for status.

---

## 5. Writing rules per document type

### 5.1 Requirements

**Purpose:** Declarative statements of *what* the system must do. No technology names. No implementation details.

**File:** `specs/00-requirements/features/{domain}-requirements.md`

**Structure:**

```markdown
# {Domain} Requirements

## Scope
One paragraph: what's in, what's out.

## Requirements

### R-{DOMAIN}-001: {Short title}
**Priority:** MUST | SHOULD | MAY
**Statement:** The system {does X} {under condition Y}.
**Rationale:** {Why this is required; who benefits; what breaks without it.}
**Acceptance criteria:**
- AC1: Given {precondition}, when {action}, then {observable outcome}.
- AC2: Given {precondition}, when {action}, then {observable outcome}.
**Source:** {user story ID, doc reference, or "derived from <spec ID>"}
```

**Rules:**

- One requirement per `###` block.
- Every acceptance criterion must be **falsifiable** — a test could exist that makes it fail.
- No `SHOULD` without a stated fallback: "if the system cannot do X, it must do Y".
- No compound requirements ("and" in the statement → split into two).
- Technology names (`Flutter`, `SQLite`, `Next.js`) are prohibited in requirements. Replace with capability ("local storage", "web rendering").

### 5.2 ADRs

**Purpose:** Immutable records of architectural decisions.

**File:** `specs/adr/{NNNN}-{short-title}.md`

**Structure:**

```markdown
# ADR-{NNNN}: {Short title}

**Status:** proposed | accepted | superseded by ADR-{NNNN} | deprecated
**Date:** YYYY-MM-DD
**Domain:** {domain}

## Context
{The forces at play. 3–10 lines. Facts, not opinions. Cite requirement or spec IDs where relevant.}

## Decision
We will {decision}. {One sentence. Imperative.}

## Consequences
**Positive:** {list}
**Negative:** {list}
**Neutral:** {list}

## Alternatives considered
- **{Alternative 1}:** {why rejected}
- **{Alternative 2}:** {why rejected}

## Compliance checklist
- [ ] {Testable assertion that verifies the decision is honoured.}
- [ ] {Testable assertion.}
- [ ] {Testable assertion.}
```

**Rules:**

- **One decision per ADR.** If you're writing "and also", it's a second ADR.
- **Immutable once accepted.** To change, write a new ADR that supersedes the old; never edit.
- **Compliance checklist items must be testable.** A CI lint, an assertion in a test, or a manual checklist step — but not "the team is aware".
- **Never state the decision without stating what was rejected.** An ADR without alternatives is a note, not an ADR.

### 5.3 Contracts

**Purpose:** Machine-readable interface definitions. The exact wire/storage/type shape.

**File:** `specs/contracts/{subtype}/{name}.{ext}` — subtype is stack-dependent (`pigeon/`, `json-schema/`, `proto/`, `openapi/`, `zod/`, `tauri/`).

**Rules:**

- **Fully typed.** Every field has: name, type, required/optional, constraints, example, description.
- **No "see implementation."** The contract must stand alone.
- **Versioned.** Either in the path (`/v1/`, `@version`) or as a top-level field.
- **Backwards-compatibility explicit.** State whether breaking changes require a version bump.
- **Runnable linter or schema validator declared** in the file header (comment in proto/pigeon, `$schema` in JSON, `openapi:` version in YAML).
- **Examples are mandatory** for every request and every response. If the format doesn't have an example field, add a `## Examples` section in an adjacent `.md`.

**Stack-specific mapping:**

| Stack | Contract format | Codegen target |
|---|---|---|
| Flutter ↔ native | Pigeon `.dart` spec | Kotlin, Swift, Dart |
| Flutter models | JSON Schema | `freezed` + `json_serializable` |
| .NET HTTP | OpenAPI | `NSwag` / `Kiota` |
| .NET IPC | `.proto` (gRPC over named pipe) | `Grpc.Tools` |
| Next.js HTTP | OpenAPI | `openapi-typescript` |
| Next.js internal | Zod schema | inferred TypeScript types |
| Next.js tRPC | router type | inferred client |
| Python HTTP | OpenAPI | `datamodel-code-generator` |
| Python internal | Pydantic model | runtime validation |
| Rust IPC (Tauri) | `#[tauri::command]` + specta | TypeScript bindings |
| Rust IPC (out-of-process) | `.proto` | `prost` |

### 5.4 Behavior specs (Gherkin)

**Purpose:** Executable acceptance criteria binding requirements to tests.

**File:** `specs/features/{domain}/{capability}.feature`

**Structure:**

```gherkin
@domain:{domain} @requirement:R-{DOMAIN}-{NNN}
Feature: {Capability}
  {One-sentence description of the user-facing capability.}

  Background:
    Given {shared precondition}

  @happy-path
  Scenario: {Descriptive name}
    Given {precondition}
    When {action}
    Then {observable outcome}
    And {additional outcome}

  @error-path
  Scenario: {Descriptive name for failure}
    Given {precondition}
    When {action that triggers failure}
    Then {observable failure outcome}
```

**Rules:**

- **Tag scenarios with the requirement ID** they realise. This is the traceability link.
- **One feature per capability**, not per domain.
- **Scenarios are black-box.** No reference to internal function names, database tables, or specific technologies. Test them via public interfaces.
- **Every requirement has at least one happy path and at least one error path scenario.**
- **Bindings are declared in the manifest** (`verifies:` field) — Gherkin without a step-definition binding is documentation, and the manifest must mark it `"aspirational": true`.
- **No UI details.** "When I tap option B" is fine; "When I tap the 3rd option at coordinates (140, 320)" is not — that belongs in UX specs.

### 5.5 UX specs

**Purpose:** Machine-readable design tokens plus screen-level behavior.

**Files:**
- `specs/ux/design-tokens.json` — one per project (or per platform in monorepos)
- `specs/ux/screens/{screen}.md` — one per screen
- `specs/ux/components/{component}.md` — one per reusable component

**Design tokens structure:**

```jsonc
{
  "$schema": "https://design-tokens.org/schema.json",
  "color": { "background": { "value": "#FFFFFF", "type": "color" }, ... },
  "spacing": { "unit": { "value": "4px", "type": "dimension" }, ... },
  "typography": { "heading": { "value": { "family": "...", "size": "..." } }, ... },
  "motion": { "button-press": { "value": { "duration": "80ms", "curve": "ease-out" } } }
}
```

**Screen spec structure:**

```markdown
# Screen: {Name}

**Route/Entry:** {deep link / navigation path}
**State owner:** {which layer manages state — never a technology name unless stack-agnostic}
**Tokens used:** {explicit list of design-token keys — never raw values}

## Layout
{ASCII sketch or bullet hierarchy. Reference tokens, not values.}

## States
| State | Trigger | Visual outcome |
|---|---|---|
| initial | mount | skeleton view |
| ready | data loaded | full view |
| error | {condition} | {recovery affordance} |
| offline | no connectivity | {affordance} |

## Interactions
- {element} → {action} → {haptic / transition / navigation} using tokens `{key}`.

## Accessibility
- Contrast ratios: {verified against which tokens}
- Touch targets: {min size from tokens}
- Screen reader: {labels that must be present}
```

**Rules:**

- **Every visual value comes from a token.** Raw hex, raw px, raw ms — never in screen specs.
- **Every state enumerated.** Missing states are the most common spec bug; force the agent to enumerate.
- **Never reference a specific widget class or component library by name.** Refer to the component spec (`components/tactile-button.md`), which owns the implementation contract.
- **If the project has no UX** (backend, CLI, library), record `"not_applicable"` in the manifest with a reason. Do not silently omit.

### 5.6 Impl plans

**Purpose:** Ordering, sequencing, and verification strategy. Not a task tracker; a dependency DAG.

**File:** `specs/impl/{phase-name}.md`

**Structure:**

```markdown
# Impl: {Phase name}

**Realises:** {list of REQ-* IDs}
**Depends on phases:** {list of IMPL-* IDs}
**Verifies via:** {list of BEHAV-* IDs and test file paths}

## Work items (DAG)

| ID | Work item | Depends on | Realises | Verified by |
|---|---|---|---|---|
| W-01 | {verb + noun} | — | REQ-{DOMAIN}-001 | BEHAV-{...} |
| W-02 | {verb + noun} | W-01 | REQ-{DOMAIN}-002 | BEHAV-{...} |

## Verification strategy
- {What test level verifies each layer.}
- {What can only be verified manually.}

## Rollback
- {How to revert if the phase fails mid-implementation.}

## Out of scope
- {Explicit non-goals for this phase.}
```

**Rules:**

- **Every work item maps to a requirement.** No orphan tasks.
- **Every work item has a verification method.** No "verify manually" unless it's genuinely the only option and is called out.
- **DAG, not a list.** Explicit `depends on` for every item.
- **Out of scope is mandatory.** Prevents scope creep during implementation.

---

## 6. Greenfield vs brownfield

The two modes differ in *how specs are authored*, not in *what specs contain*.

| Concern | Brownfield | Greenfield |
|---|---|---|
| **Starting point** | Code exists; specs describe and constrain | No code; specs describe and mandate |
| **Requirements source** | Code, tests, issues, external docs | Human brief, external requirements doc |
| **Contracts** | Descriptive (what exists) unless marked `[TARGET]` | Prescriptive (what must exist) |
| **Behavior specs** | Test bindings are mandatory; `aspirational: false` | Test bindings may be `aspirational: true` until impl |
| **ADRs** | Reconstruct historical decisions; may reveal drift | Author decisions before code exists |
| **Impl plans** | Describe incremental changes | Describe full build sequence |
| **Compliance checklists** | Verifiable against current code | Verifiable against target state (after impl) |
| **Manifest `mode`** | `"brownfield"` | `"greenfield"` |

**Hybrid (most real projects):** set `"mode": "hybrid"` and add `"mode"` per-domain in the manifest. Example: quiz domain is brownfield, new billing module is greenfield.

**Brownfield discipline:** every claim in a brownfield spec must be traceable to either (a) code, (b) a test, (c) an existing document, or (d) an explicit human decision. Claims from inference are `[ASSUMPTION]` markers until confirmed. **Never** assert a brownfield behavior without evidence.

**Greenfield discipline:** every claim in a greenfield spec is a *decision* — there is no "existing behavior". The authoring protocol applies more strictly: nothing is assumed from code because there is no code. Every question is a design choice.

---

## 7. Batch-readiness requirements

Specs will be handed to a batch system (e.g. `batch-review`) that runs multiple tasks, each needing its own subset of specs plus relevant code.

**The manifest must support mechanical context derivation.** Two derivations are required:

### 7.1 Code → Specs (for "review this code" tasks)

Given a code path `P`, the set of specs to include is:

```
specs_for(P) = { s in manifest.specs | s.governs matches P }
             ∪ { s in manifest.specs | s.id in transitive_depends_on(specs_for(P)) }
```

The `governs` field is what makes this work. Every spec that constrains a code path *must* list it in `governs`.

### 7.2 Spec domain → Specs + Code (for "review this domain" tasks)

Given a domain `D`, the set of specs to include is:

```
specs_for(D) = { s in manifest.specs | s.domain == D }
code_for(D)  = union(s.governs for s in specs_for(D))
```

The `domain` field is what makes this work. Every spec must have exactly one domain.

### 7.3 Rules the spec set must satisfy

| Rule | Why |
|---|---|
| Every spec has a `domain` in `manifest.domains` | Domain-scoped batch tasks |
| Every spec has a `governs` (except `behavior` with `verifies`) | Code-scoped batch tasks |
| No spec larger than the size limits in §3.3 | Context budget per task |
| No `depends_on` cycle | Deterministic transitive closure |
| Every `depends_on` target is `accepted` or `superseded` | Finalised specs only |
| Every `behavior` spec has either `verifies` populated or `aspirational: true` | Truth in advertising |
| No prose spec references a code path without a matching `governs` entry | Traceability |

**Do not attempt to encode batch task definitions inside specs.** Batch tasks are a batch-tool concern (see the per-task context mechanism). Specs merely declare what they govern; the batch tool constructs tasks.

---

## 8. Stack appendices

Each appendix tells the agent **what "contract", "behavior", "UX" map to** in that stack, and **what gotchas** the writing rules must account for.

### 8.1 Flutter / Dart

**Detection:** `pubspec.yaml` with `flutter:` dependency.

**Contracts:**
- **Native bridge:** Pigeon `.dart` spec files under `specs/contracts/pigeon/`. Pigeon emits Dart, Kotlin, Swift. Source of truth is the spec, not the generated bindings.
- **Domain models:** JSON Schema under `specs/contracts/json-schema/`, feeding `freezed` + `json_serializable`.
- **Database:** Drift schema is generated from Dart classes; the *specification* is the JSON Schema of the domain model, not the Drift table. Tables may denormalise; the domain model may not.
- **Deep links:** `routing-manifest.yaml` if universal/app links are used.

**Behavior:**
- Gherkin `.feature` files bound to `flutter test` via `bdd_widget_test` or hand-written `testWidgets` step bindings under `mobile-app/test/step_definitions/`.
- Integration tests via `integration_test/` bound to `.feature` files tagged `@integration`.

**UX:**
- `design-tokens.json` feeding `theme_extensions_builder` or `flutter_gen`.
- Screen specs reference tokens by key. Widget names are prohibited in screen specs (they belong in `components/`).
- Physical specs (tap target sizes, animation durations) come from tokens, not from prose.

**Gotchas:**
- **Zero-network-egress ADRs are critical.** Every new dependency must be checked against the egress ADR. The compliance checklist must include a test asserting no HTTP client is imported.
- **Dual database architecture.** If the app has a read-only prepopulated DB and a writable user DB, that must be its own ADR with a compliance checklist.
- **Platform channels must be Pigeon-specified, not raw `MethodChannel` strings.** Any raw `MethodChannel` in the code is a spec violation; add it to the compliance checklist of the relevant bridge contract.
- **No `Colors.white` / `Colors.black` outside the theme layer.** Theme safety is a compliance checklist item, not just a guideline.
- **Deferred permission requests** (notification, exact alarm) are behavior specs, not UX specs.

**.NET / C#**

**Detection:** `*.csproj` or `*.sln`, plus `Program.cs` / `Startup.cs`.

**Contracts:**
- **HTTP APIs:** OpenAPI under `specs/contracts/openapi/`, split by domain with `$ref`.
- **gRPC / IPC:** `.proto` under `specs/contracts/proto/v1/`.
- **DTOs:** If the API is not OpenAPI, use JSON Schema for request/response bodies.
- **Named pipes / message bus:** AsyncAPI.

**Behavior:**
- Gherkin `.feature` files bound to `Reqnroll` (the successor to SpecFlow) or `xunit` step bindings.

**UX (if applicable):**
- WPF / WinForms / MAUI: XAML screens under `specs/ux/screens/` with a reference to the XAML file that implements them. The screen spec is descriptive; the XAML is the implementation.

**Gotchas:**
- **Strong typing means contracts are compiled, not runtime-validated.** If a contract is wrong, the build fails. This means contracts must be finalised *before* code generation runs — no draft contracts in CI.
- **`Grpc.Tools` codegen** must be wired into `csproj` build targets; the contract file is the source, generated `.cs` is checked in or built on demand.
- **Nullable reference types** make optionality explicit — the contract must match. A field that is "optional" in the spec but non-nullable in C# is a bug.

### 8.3 Next.js / TypeScript

**Detection:** `package.json` with `"next"` dependency, plus `next.config.*`.

**Contracts:**
- **HTTP APIs (App Router route handlers):** OpenAPI under `specs/contracts/openapi/`, feeding `openapi-typescript` for client types.
- **Internal server-client boundaries (tRPC):** tRPC router types are the contract. Document the router shape in a `.md` under `specs/contracts/trpc/`; the actual TypeScript type is the source of truth but the `.md` records intent and versioning.
- **Runtime validation:** Zod schemas under `specs/contracts/zod/`. These are executable contracts — one schema, one file, one exported type.

**Behavior:**
- **E2E:** Playwright tests under `mobile-app/e2e/` or `e2e/`, bound to `.feature` files (via `playwright-bdd` or hand-written bindings).
- **Component:** Vitest + Testing Library, bound to component specs.
- **Server:** Vitest for route handlers.

**UX:**
- `design-tokens.json` feeding Tailwind config (via `tailwind.config.ts` extend or a plugin).
- Route specs under `specs/ux/screens/` mapping 1:1 to route segments in `app/`.
- Storybook stories are executable UX specs — each screen spec must link to its story, and each story must implement the spec's states.

**Gotchas:**
- **TypeScript's structural typing** means contract drift is invisible at compile time if the contract is written as a `.ts` interface. Prefer Zod schemas (runtime) over `.ts` interfaces for anything crossing a boundary.
- **Server Components vs Client Components** is a decision per route — this belongs in an ADR, not scattered in code comments.
- **Environment variables** are contracts; declare them in a `specs/contracts/env/` schema.
- **App Router route groups** map to domains — use them for `specs/domains` consistency.

### 8.4 Python

**Detection:** `pyproject.toml` or `requirements.txt`, `src/` or top-level `*.py`.

**Contracts:**
- **HTTP APIs (FastAPI):** The OpenAPI schema is generated from Pydantic models — but Pydantic models are the source of truth. Write them under `specs/contracts/pydantic/` and have `src/` import them.
- **HTTP APIs (other frameworks):** OpenAPI under `specs/contracts/openapi/`.
- **Internal boundaries:** Pydantic models are the canonical contract. A dataclass without validation is not a contract.

**Behavior:**
- Gherkin `.feature` files bound to `pytest-bdd` under `tests/step_definitions/`.

**UX (rare):**
- Streamlit / Gradio / Textual apps: screen specs are usually unnecessary; use behavior specs and impl plans instead.
- Web UIs served from Python (Jinja, etc.): treat as a Next.js-like case; the HTML structure is the UX spec.

**Gotchas:**
- **Type hints are the contract but they are not enforced.** Use `mypy` or `pyright` in CI; a contract that is only a type hint and not runtime-validated can drift.
- **Pydantic models should live under `specs/contracts/`** and be imported into `src/`, not the other way around. This is the only stack where the contract file is *also* runtime code — treat the `specs/contracts/pydantic/` folder as a package that ships.
- **Async vs sync boundaries** must be specced — a sync function called from async code is a common source of bugs and should have an ADR if it's a pattern.

### 8.5 Rust / Tauri

**Detection:** `Cargo.toml` with `[package]`; Tauri if `tauri.conf.json` + `src-tauri/` exist.

**Contracts:**
- **Tauri commands:** `#[tauri::command]` functions are the IPC contract. Use `specta` or `ts-rs` to emit TypeScript bindings under `specs/contracts/tauri/`. The `.rs` file that defines the command is referenced from a `specs/contracts/tauri/{command}.md` that documents the contract, but the source of truth is the Rust code.
- **Out-of-process IPC:** `.proto` under `specs/contracts/proto/v1/`, feeding `prost`.
- **Tauri capabilities:** `capabilities/*.json` under `specs/contracts/tauri/capabilities/` — this is a contract, not a config file. Treat it as such.

**Behavior:**
- Gherkin `.feature` files bound to `cucumber-rs` or `cargo test` step bindings.

**UX:**
- If Tauri frontend is Next.js: see 8.3.
- If Tauri frontend is vanilla TS / Svelte / Vue: design-tokens + screen specs as in Flutter, minus the token generator specifics.

**Gotchas:**
- **The type system enforces most contract concerns at compile time.** This is Rust's strength — but it means contract drift happens at *the boundary* (serde serialization, Tauri command signatures, capabilities) rather than internally.
- **Capabilities are the security contract.** Every Tauri command exposed to the frontend must be listed in a capability file. That file goes under `specs/contracts/tauri/capabilities/`.
- **`specta` and `ts-rs` generate bindings from Rust, not the other way around.** This is the opposite of Pydantic — contracts live in code and are *exported* to specs. Write the `.md` spec as documentation of what exists, and have the manifest mark the Rust file in `governs`.
- **Rust lifetime/ownership boundaries** are not contract concerns (they don't cross the boundary) — do not spec them.

---

## 9. Quality gates

Before Phase E completes, all gates must pass. Failing gates block finalisation.

| # | Gate | Check |
|---|---|---|
| G1 | **Manifest validity** | `manifest.json` parses; every `path` exists; every `depends_on` target exists and is `accepted` or `superseded`; no cycles. |
| G2 | **Size limits** | Every file within §3.3 limits. |
| G3 | **No markers remain** | `grep -r '\[ASSUMPTION:' specs/` and `grep -r '\[UNRESOLVED:' specs/` return zero. |
| G4 | **Every requirement has an ID** | Every `### R-{DOMAIN}-{NNN}` heading in every requirements file. |
| G5 | **Every ADR has a compliance checklist** | Non-empty `## Compliance checklist` section. |
| G6 | **Every behavior spec has a binding** | Either `verifies` populated or `aspirational: true`. |
| G7 | **Every contract has an example** | Every request and response shape has an example. |
| G8 | **No technology in requirements** | Grep requirements files for the detected stack names + common technology words (`Flutter`, `SQLite`, `React`, `Postgres`, `Python`, `Rust`, `Tauri`, `Next.js`, `gRPC`). Zero hits outside `**Rationale:**` blocks that explicitly cite them. |
| G9 | **Every UX spec references tokens, not values** | Grep UX files for raw `#[0-9a-f]{3,8}` and `\d+px` and `\d+ms`. Zero hits. |
| G10 | **Every impl plan work item has a requirement** | Every row in every DAG table has a `Realises` value matching `REQ-*`. |
| G11 | **Domain consistency** | Every `domain` in every spec is in `manifest.domains`. |
| G12 | **Governs consistency** | Every `governs` glob matches ≥1 existing file (brownfield) or is marked `[TARGET]` (greenfield). |
| G13 | **Stack appendix applied** | For every detected stack, the appendix-specific gotchas section has been addressed (either implemented or recorded as `"not_applicable"` with reason). |

G8 and G9 are the two most-often-skipped gates — they separate real spec-driven development from documentation that happens to be structured.

---

## 10. Anti-patterns

These are failure modes that agents and humans both fall into. Recognise and refuse.

| Anti-pattern | Symptom | Correction |
|---|---|---|
| **The mega-spec** | One file containing all requirements for the whole system | Split by domain; enforce §3.3. |
| **The silent assumption** | Agent writes "the system caches responses" without evidence | Must be `[ASSUMPTION]` with evidence, or an ADR. |
| **The unimplementable criterion** | "The UI should be intuitive" | Acceptance criterion must be falsifiable. |
| **The unfalsifiable checklist** | Compliance item: "team understands the decision" | Compliance item must be a test/lint/assertion. |
| **The technology leak** | Requirements say "use Redis for caching" | Technology belongs in ADRs; requirements say "cache hot data". |
| **The Gherkin that isn't** | `.feature` file with no step bindings and no `aspirational: true` | Either bind it or declare it aspirational. |
| **The reusable screen** | Screen spec references `<TactileButton>` directly | Screen spec references `components/tactile-button.md`. |
| **The orphan work item** | Impl plan has a work item with no requirement | Either add the requirement or delete the work item. |
| **The stale ADR** | ADR edited after acceptance to reflect new decision | Supersede, don't edit. |
| **The unresolved "TBD"** | Final spec contains "TBD" or "TBC" | Must be resolved, or moved to `## Known Gaps` with manifest `accepted_with_gaps`. |
| **The out-of-scope creep** | Impl plan omits `## Out of scope` | Mandatory section; omission is a gate failure. |
| **The contract that isn't** | Contract file says "see source for details" | Contracts are self-contained. |
| **The batch-hostile spec** | One spec file that governs 40 unrelated code paths | Split until each spec governs a cohesive set. |
| **The ghost domain** | Domain declared in manifest but no specs use it | Remove from `manifest.domains`. |
| **The multiple-decisions ADR** | ADR titled "Auth, sessions, and password policy" | Split into three ADRs. |

---

## Appendix: one-page cheat sheet

For the agent, before every phase transition:

**Phase A exit:** Context Brief written. Mode, stack, domains, spec set confirmed by human.

**Phase B exit:** Blocking questions answered. Question format followed. ≤7 per round.

**Phase C exit:** Every spec exists as `draft`. Every inference is `[ASSUMPTION]`. Every unknown is `[UNRESOLVED]`. Every spec has `## Traceability`. Manifest updated.

**Phase D exit:** Resolution doc complete. Zero markers remain.

**Phase E exit:** Quality gates G1–G13 pass. Manifest `accepted`. `specs/README.md` written.

**Always:**
- One concept per file.
- No technology names in requirements.
- No raw values in UX specs.
- No "see implementation" in contracts.
- No unfalsifiable acceptance criteria.
- No ADR without alternatives.
- No Gherkin without a binding or `aspirational: true`.
- No work item without a requirement.
- No silent assumptions. Ever.

**Batch-readiness invariants:**
- Every spec has `id`, `type`, `domain`, `status`, `depends_on`, `path`.
- Every non-behavior spec has `governs`.
- Every behavior spec has `verifies` or `aspirational: true`.
- No file exceeds its size limit.
- No `depends_on` cycle.

---

*End of guide. Save as `specs/GUIDE.md` in each repo, or as a template the agent loads before Phase A. Version this document alongside the manifest; when the guide changes, bump `manifest.version` and record why in an ADR.*