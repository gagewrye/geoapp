# 036: Class palette

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none. **Builds on specs 003 and 035.**

**Goal:** Each class row shows its key, its colour and its name at a glance. Renaming is an explicit action, so typing a shortcut never edits a name by accident.

## Scope
1. A row shows, left to right:
   - the hotkey number, `1`–`9` for the first nine classes and blank after that;
   - a colour swatch, which is the existing `input[type=color]` styled as a 16 px square;
   - the name as text (a `span.class-name`, ellipsis, full name in `title`);
   - a rename button (`✎`, `aria-label="Rename <name>"`).
2. A click anywhere on the row except the swatch and rename selects the class, as now. The visually hidden radio stays, so keyboard selection and `aria-selected` keep working.
3. **Rename.** Double-clicking the name, or pressing rename, swaps the span for a text input with the name selected.
   - `Enter` or blur commits through the existing `checkName`. A rejected name shows `MESSAGES.className` and keeps the old name.
   - `Escape` cancels.
   - While the input has focus, every shortcut is ignored (`inTextField`). The `Escape` keydown does not reach spec 033's Pan key.
4. When locked (spec 004), the rename button and swatch are disabled and double-click does nothing. Selection still works.
5. The list fills spec 035's Classes section, with no 40vh cap. Selecting a class by key scrolls its row into view (`block: "nearest"`).

**Out of scope:** reordering, deleting classes, per-class visibility, user-set hotkeys.

## Interfaces
- `ui/classList.ts`: `renderClasses` keeps its signature and its `Handlers`. `markSelected` also scrolls the selected row into view.
- No `core/` change.

## Acceptance criteria
1. **Unit (DOM):**
   - With 12 classes, rows 1–9 show `1`…`9`, and rows 10–12 show no number.
   - Every row has a swatch whose value is the class colour, and a name span with the class name.
2. **Unit:**
   - Clicking a row's name span calls `select(i)`.
   - Clicking its swatch or rename button does not.
3. **Unit:**
   - Rename then `Enter` with a new unique name calls `rename(i, name)`, and the span shows the returned name.
   - `Escape` restores the old name without calling `rename`.
   - A duplicate name shows the old name.
4. **Unit:** when locked, the swatch and rename are disabled, and double-click opens no input.
5. **E2E:** while renaming, typing `b2e]` puts those characters in the name and changes neither the mode, the class nor the brush size.
6. **E2E:** with 40 classes, `#classes` is taller than 40vh when the window allows it. Selecting the 9th class by key leaves its row visible.
7. Spec 003's class criteria (rename, recolour, Add class) pass with the new selectors. `npm run check` passes.
