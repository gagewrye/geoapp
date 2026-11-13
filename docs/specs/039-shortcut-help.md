# 039: Shortcut help

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none (native `<dialog>`). **Builds on specs 031–038.** It goes last because it lists their keys.

**Amended by spec 057 (2026-11-11):** in scope 4, a button whose entry has a `hint` gets it as the title's lines after the key, `<action> (<key>)\n<hint>` (a hint may hold `\n`); the platform for Cmd or Ctrl is passed to `labelButtons`.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `shortcut-help` (criteria 3–5); unit `ui/shortcuts`' scans of `index.html` and of string literals in `labelKeys.ts` and `help.ts`. `ui/help` and `ui/shortcuts` tests stay; no e2e test of the help is left.

**Goal:** The user can see every shortcut in one place, and each button shows its shortcut on hover.

## Scope
1. A single table, `SHORTCUTS` in `ui/shortcuts.ts`, lists every keyboard and mouse shortcut as `{ keys, action, button? }`. Its sections are Tools, Brush, Classes, View, Navigation and Edit.
   - The keys today are 1–9, `[` `]`, Space, W A S D, Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, B, E, P / Esc, H, the peek key, `\`, Home, I, Alt+click, right drag, middle drag, wheel and `?`.
2. The `labelKeys` single-key handlers are looked up from a key map exported by `ui/labelKeys.ts` (`KEYMAP`), so the table and the handling can be compared in a test.
3. `?` (`e.key === "?"`), or a `?` button at the right end of `#topbar`, opens `<dialog id="help">` with `showModal()`. It lists the table grouped by section.
   - `Escape`, the dialog's Close button, or `?` again closes it.
   - While it is open, no other shortcut acts: `Escape` closes only the dialog and does not select Pan.
4. Every button named by a `button` field gets `title` and `aria-keyshortcuts` from the table, for example `Paint (B)` and `aria-keyshortcuts="B"`.
5. The keys are ignored in text fields, with Ctrl/Meta/Alt held, as the other shortcuts are. `?` also works before a raster opens.

6. **Carried from spec 038's review** (non-blocking there):
   - `labels.open()` and `replace()` cancel a pick still reading. Otherwise, after a smaller raster opens, `labelAt` throws an uncaught `RangeError`, and after an import the old value selects from the new class list.
   - A labelled value above the class count says its own info message, `MESSAGES.noClass(v)` = `No class for value <v>.`, not `No label here.`

**Out of scope:** remapping keys, a first-run tour.

## Interfaces
- `ui/shortcuts.ts`: `type Shortcut = { section: string; keys: string[]; action: string; button?: string }` and `SHORTCUTS: readonly Shortcut[]`.
- `ui/labelKeys.ts`: `KEYMAP: Record<string, string>`, which maps a `KeyboardEvent.key` or `code` to an action id that `SHORTCUTS` also uses.
- `ui/picker.ts`: `initPicker` returns `{ pick(cell): Promise<void>; cancel(): void }`. `cancel` bumps `latest`, so a pick still reading ends silently, even if its read then fails.
- No `core/` change.

## Acceptance criteria
1. **Unit:** every `KEYMAP` key appears in some `SHORTCUTS` entry, and every `SHORTCUTS` key that is a single key appears in `KEYMAP`.
2. **Unit (DOM):**
   - Each `button` id in `SHORTCUTS` exists in `index.html`.
   - After init, its `title` ends with `(<key>)`, and its `aria-keyshortcuts` is set.
3. **E2E:**
   - Pressing `?` opens `#help` as a modal listing at least the 19 entries in scope 1.
   - Pressing `Escape` closes it and leaves the mode unchanged.
   - Pressing `?` then clicking Close also closes it.
4. **E2E:** with `#help` open, pressing `B`, `H` or `]` changes nothing.
5. **E2E:** with focus in a class-name field, typing `?` puts the character in the name.
6. `npm run check` passes.
7. **Unit (picker, scope 6):** a pick whose `tile()` resolves, or rejects, after `cancel()` calls neither `select` nor `say`, with no unhandled rejection. This holds with `dims()` shrunk so that the cell lies outside it.
8. **Unit (labels, scope 6):** `open()` and `replace()` each call the picker's `cancel` once.
9. **Unit (picker, scope 6):** with 3 classes, a value of 5 keeps the selection and says `No class for value 5.` (info). A value of 0 still says `No label here.`
