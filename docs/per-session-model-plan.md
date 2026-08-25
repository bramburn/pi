# Plan: Per-Session Default Model

## Context

Currently `defaultModel` is a global setting stored in `~/.pi/settings.json`. When a user starts a new session (or resumes one), the model is resolved from:

1. `--model` / `--models` CLI flags (most specific)
2. Saved `defaultModel` from global/project settings (fallback)
3. First available model (last resort)

There is no per-session model preference. If a user works on project A with `claude-opus` and project B with `claude-haiku`, they must manually set the model each time or accept the global default.

## Goal

Allow each `.pi-session` file to carry a `defaultModel` preference that overrides the global setting when that session is opened.

## Current Architecture

### Settings hierarchy

`SettingsManager` (`settings-manager.ts`) maintains three settings layers:

```
~/.pi/settings.json         → globalSettings  (globalDefaults: "regular")
<cwd>/.pi/settings.json   → projectSettings  (projectDefaults: { "tuiMode": "fullscreen" })
merged: globalSettings + projectSettings → this.settings
```

`defaultModel` lives in `Settings.defaultModel`. `getDefaultModel()` reads `this.settings.defaultModel`. `setDefaultModelAndProvider()` writes to `this.globalSettings` (always global, never project).

### Model resolution in main.ts

`buildSessionOptions()` (`main.ts:buildSessionOptions`) resolves the initial model:

```
if (parsed.model) → use CLI model
else if (scopedModels.length > 0 && !hasExistingSession) → pick from scoped list (saved default or first)
else → sessionOptions.model = undefined → must be provided via --model
```

`scopedModels` comes from `--models` CLI flag or `settingsManager.getEnabledModels()`.

### How the user changes model in the TUI

`model-selector.ts:367`: `this.settingsManager.setDefaultModelAndProvider(model.provider, model.id)` — writes to **global** settings, not session settings.

### Session file format

Sessions are JSONL files (`.pi-session`). The first line is a `SessionHeader`:

```typescript
// session-manager.ts:32
export interface SessionHeader {
    type: "session";
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
}
```

No model field currently.

### How model is tracked in a session

`SessionContext.model` (in-memory) is built by `getSessionContextSettings()` from conversation entries:

```typescript
// session-manager.ts:362
for (const entry of path) {
    if (entry.type === "model_change") {
        model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
        model = { provider: entry.message.provider, modelId: entry.message.model };
    }
}
```

For a **new session** with no history: `model = null`. The initial model comes from the caller (`createAgentSession()`).

### AgentSession initialization

`AgentSession` (`agent-session.ts`) is constructed via `createAgentSessionFromServices()` with `options.model`. If not provided, `agent.state.model = DEFAULT_MODEL = { id: "unknown", ... }`.

## Proposed Changes

### 1. Extend `SessionHeader` (`session-manager.ts`)

```typescript
export interface SessionHeader {
    type: "session";
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
    // NEW:
    model?: { provider: string; modelId: string };
    thinkingLevel?: ThinkingLevel;
}
```

This makes the session file the authoritative store for the session's preferred model.

### 2. Read session model when loading (`session-manager.ts`)

In `readSessionHeader()` or a new `getSessionDefault()` method, extract the model from the header so callers can access it before constructing `AgentSession`.

```typescript
export function getSessionDefaultFromHeader(header: SessionHeader | null): {
    model?: { provider: string; modelId: string };
    thinkingLevel?: ThinkingLevel;
} | null {
    if (!header) return null;
    return {
        model: header.model,
        thinkingLevel: header.thinkingLevel,
    };
}
```

### 3. Write session model when starting a new session (`session-manager.ts`)

When creating a new `SessionManager` with a path (not resuming), the session file is created via `_setSessionFile()`. The header is written by appending the first entry.

Add `model` and `thinkingLevel` to the header at creation time if provided:

```typescript
// In SessionManager constructor or _setSessionFile when creating new file
if (persist && this.sessionDir && !existsSync(this.sessionFile)) {
    // ... mkdir ...
    const header: SessionHeader = {
        type: "session",
        id: this.sessionId,
        timestamp: new Date().toISOString(),
        cwd: this.cwd,
        model: options?.initialModel,
        thinkingLevel: options?.initialThinkingLevel,
    };
    // write header to file
}
```

### 4. Pass session model to `createAgentSessionRuntimeFactory` (`main.ts` / `agent-session-runtime.ts`)

When creating the runtime factory, read the session default and pass it to `createAgentSessionFromServices`:

```typescript
// In the createRuntime factory in main.ts
const sessionHeader = sessionManager.getHeader();
const sessionDefault = getSessionDefaultFromHeader(sessionHeader);
const initialModel = sessionDefault?.model
    ? modelRuntime.getModel(sessionDefault.model.provider, sessionDefault.model.modelId)
    : undefined;
// pass initialModel to createAgentSessionFromServices
```

### 5. Update model selector to write to session, not global settings (`model-selector.ts`)

Currently:
```typescript
this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
```

Change to: write the model to the session file header (for the current session), or provide a separate "save as session default" action.

Question: should changing the model in the UI always update the session file? Or should there be an explicit "Make this the default for this session" action? Likely: always update the session header when the user explicitly selects a model (not just cycling).

### 6. Handle `--model` CLI flag precedence

CLI flags should still win over session file defaults:
- `--model` / `--models` → use CLI (existing behavior)
- Session file `model` → use session default
- Global `defaultModel` → last resort

Update `buildSessionOptions()` to accept a session default and apply it when no CLI model is given.

### 7. Backward compatibility

Old session files without `model` in the header: `getSessionDefaultFromHeader()` returns `null`, falls back to global settings (current behavior).

## Files to Modify

| File | Change |
|------|--------|
| `session-manager.ts` | Add `model`/`thinkingLevel` to `SessionHeader`, add `getSessionDefaultFromHeader()` |
| `agent-session-runtime.ts` | Accept `initialModel` option in `CreateAgentSessionRuntimeFactory` |
| `main.ts` | Read session default, pass to `createAgentSessionFromServices` |
| `model-selector.ts` | Write to session header instead of global settings |
| `SessionManager` constructor | Accept `initialModel`/`initialThinkingLevel`, write to header |

## Open Questions

1. **Model selector behavior**: When the user selects a model in the TUI, should it always update the session file header, or require an explicit confirmation? Current behavior writes to global settings (so all new sessions use that model). The user may want different behavior: always-per-session vs. opt-in.

2. **`--models` (scoped models) interaction**: If a session has a `defaultModel` of `claude-opus`, but `--models claude-haiku claude-opus` is used, what wins? Likely: scoped models list takes precedence, session `defaultModel` is only used when no `--models` is given.

3. **Resume existing session**: When resuming a session, should the session file's `model` field take precedence over the global default? Probably yes — the session file is the source of truth for that session's preferred model.

4. **Nested sessions / forks**: When branching a session, does the child inherit the parent's `defaultModel`? Logical answer: yes, unless overridden.

5. **UI indication**: Should the TUI show whether the current model is from the session file, CLI, or global settings? Helps users understand the precedence.

## Verification

- Write a test: create a session with a specific `defaultModel`, verify it is read back when loading the session
- Write a test: verify `--model` flag still overrides session default
- Write a test: verify old sessions (no model in header) fall back to global default
- Manual: start a session with `defaultModel` set, verify model selector shows the right default
