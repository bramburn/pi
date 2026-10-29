# Context Brief — Clipboard paste: Alt+V image/text, right-click, Claude-Code-style asset folder

Phase A deliverable for `specs/GUIDE.md`. Human confirms/corrects before Phase B.

## Mode / stack / domain

- **Mode:** `hybrid` — brownfield paste pipeline exists and is tested; the "persist pasted media into a resources/assets folder" behaviour does not exist anywhere yet (greenfield slice).
- **Stack:** `typescript`, `bun` (matches existing `specs/manifest.json`).
- **New domain:** `clipboard` (added to `manifest.domains`; existing domains `rebrand`, `extensions`, `subagents`, `compaction` untouched).

## What exists (brownfield, verified)

Three paste entry points, all in `packages/coding-agent`:

| Entry | Binding | Handler | Behaviour |
|---|---|---|---|
| `app.clipboard.pasteImage` | `ctrl+v` (all platforms) | `handleClipboardPaste()` `interactive-mode.ts:3006` | image → video → PDF → text cascade; media stored **in-memory** behind `[paste #N image: …]` marker (`editor.pasteImage`, `packages/tui/src/components/editor.ts:1391`) |
| `app.clipboard.pasteText` | `alt+v` | `handleClipboardPasteText()` `interactive-mode.ts:3045` | **text only**, always `forceMarker` — never inspects the clipboard for an image |
| Right-click (win32 only, not VS Code) | mouse | `handleRightClickPaste()` `interactive-mode.ts:2997`, gated at `tui-alt-screen.ts:727` | reads **text only** via `readClipboardText()`, wraps in `\x1b[200~…\x1b[201~`, editor bracketed-paste path collapses >10 lines/1000 chars into a marker (`editor.ts:1304`, `:1355`) |

Key facts:

- **No disk persistence anywhere in the paste path.** `PasteAttachment` (`editor.ts:28`) is `{kind, bytes/mime/fileName}` held in an editor `Map`; submit base64s bytes into `ImageContent` (`interactive-mode.ts:251`) and never writes a file. There is no existing `resources/`/`assets/` attachment folder.
- **Alt+V ignores images today.** `handleClipboardPasteText` only calls `readClipboardText()` — a screenshot on the clipboard yields nothing. This contradicts docs (`docs/keybindings.md:128`, `docs/usage.md:26`, `docs/quickstart.md:118`) which still describe the pre-#937 Windows `alt+v = pasteImage` behaviour.
- **Right-click never inspects the clipboard for images** — it is text-only by construction, so an image clipboard pastes either nothing or the text flavour (e.g. copied HTML/text accompanying an image), i.e. "the entire text".
- Right-click paste is **Windows-only** (`process.platform !== "win32"` → no-op) and disabled in VS Code.
- Video/PDF follow the same marker path but upload only when `modelSupportsMediaUpload` allows; images always upload.
- Existing tests: `test/interactive-paste-handler.test.ts` (Alt+V/cascade), `test/interactive-tui.test.ts:53` (right-click bracketed paste), `test/clipboard-*.test.ts` (OS backends).

## Existing decisions inferred from code (marked inferred, not accepted)

- Paste media is an **in-memory registry keyed by marker id**, not files — chosen by PR #937 (atomic paste markers). [inferred]
- Keybinding split: `ctrl+v` = image-or-text, `alt+v` = forced text marker — introduced by #937; docs describing `alt+v` as image paste on Windows are stale. [inferred]
- Right-click paste is deliberately win32-only + VS-Code-excluded (Windows terminals route Ctrl+V to the shell). [inferred]

## Open questions for Phase B (prioritised)

1. **(blocking)** Where does the "resources/assets folder" live? Project-local (`.qi/assets/` in cwd), user-global (`~/.qi/agent/…`), or session dir? What is the file naming scheme and retention?
2. **(blocking)** What does the editor insert after an image paste — keep `[paste #N image: …]` (bytes read back from the file at submit), insert the file path as text, or both?
3. **(blocking)** Right-click: route through the full image→video→PDF→text cascade (unifying with Ctrl+V), or image+text only? Does the "pastes the entire text" complaint also cover marker collapsing for long text?
4. **(high)** Alt+V: make it delegate to `handleClipboardPaste` (image-or-text) while keeping `forceMarker` for the text fallback — i.e. two bindings, one cascade — or leave Alt+V text-only?
5. **(high)** Does disk persistence apply to **all** paste entry points (Ctrl+V included) or only Alt+V/right-click?
6. **(high)** Claude Code parity: pending research — what Claude Code actually does (inline attach vs. file drop) decides whether this is parity or a qi-specific design.
7. **(low)** Should the folder be git-ignored / cleaned up per session?

## Proposed spec set

| Type | Path | Notes |
|---|---|---|
| Requirements | `specs/00-requirements/features/clipboard-requirements.md` | `REQ-CLIP-…` |
| ADR | `specs/adr/0007-paste-media-disk-assets-folder.md` | storage location + marker-vs-path decision (only if Phase B confirms) |
| Contract | `specs/contracts/json-schema/paste-attachment.schema.json` **or** not_applicable | depends on whether attachment shape changes |
| Behavior | `specs/features/clipboard/paste-media.feature` | `aspirational: true` until bindings exist |
| UX | `not_applicable` | TUI, no visual token surface (consistent with existing manifest note) |
| Impl | `specs/impl/clipboard-paste-phase.md` | DAG wiring keybindings → handlers → persistence → tests |

## Proposed `governs` globs

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`
- `packages/coding-agent/src/core/keybindings.ts`
- `packages/coding-agent/src/utils/clipboard*.ts`
- `packages/tui/src/components/editor.ts`
- `packages/coding-agent/src/modes/interactive/tui-alt-screen.ts` gate (`packages/tui/src/tui-alt-screen.ts`)
