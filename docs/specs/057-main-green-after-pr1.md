# 057: `npm run check` and the e2e suite pass on main again

**Status:** Accepted (2026-11-11). Gage approved fixing this before spec 055 is reviewed, and answered its questions on 2026-11-11 (below). **ADRs:** none (no dependency or architecture change). **Branches from `main` (e32d961).** It amends:
- spec 036 criterion 10, spec 037 criterion 9 and spec 050 criterion 8 (README wording);
- spec 039 scope 4 (a title may have a hint line);
- spec 046 criterion 7 (its title test).

Spec 055's branch rebases on this. Spec 056 criterion 10 assumes this has merged.

## Decided by Gage (2026-11-11)
1. **README.** Gage deliberately shortened the README in 5594d74 ("Update README.md", 2026-11-03, "Reduced AI verbosity"), which removed "clear **Show** (H)", "**Redo**" and the Save dialog sentence. `git log -S`, checked by the orchestrator, confirms this; PR #1 did not remove them. The short README stays, and the tests change.
2. **Hover hints (07c50a0)** stay, and are specified here (scope 3).
3. **Hint texts (2026-11-11).** Gage set the four hints in scope 3, verbatim from his request: "For smart select - change to "Click an object to create an AI-generated mask. More clicks add to it...[rest of text as is]" Fill - "Click an area to change every connected pixel of the same class to the selected class." Erase - "Removes the selected class" Paint - "Left Drag: paints the selected class \n Right Drag: removes the selected class"". His `\n` is a real line break, with no spaces around it.

## Decisions (from the code and specs)
- **README-wording tests: the tests are wrong** (Decided 1). Only the README-text assertions that the short README fails are deleted.
- **Unit Redo title: the test is wrong.** Since spec 045 scope 5, the title says Cmd on Mac. Node 22 has a global `navigator.platform`, so `IS_MAC` is true under Vitest on macOS. This failure predates PR #1.
- **E2E `Control+z`: the tests are wrong.** Spec 045 scope 7 leaves Ctrl+Z unbound on Mac. 11 presses in 7 files (smart-select ×2, undo ×3, tool-keys, label-import-progress, label-view-pan.tester, nav-undo.tester ×2, undo-seed) assume Ctrl. These also predate PR #1. On Mac, the "does nothing" checks pass without testing anything.
- **E2E exact titles: the tests are wrong.** Since 07c50a0, a button with a hint has the title `Smart select (M)\n<hint>`. The tests still expect the old title exactly: smart-select.spec:131, fill-polygon.spec:126-127 and layout.spec:44.

## Scope
1. **README tests.** `README.md` is unchanged.
   - In `readme.test.ts`, the spec 037 test drops its `**Redo**` assertion. It keeps the check that the README has no "shows the labels again, and the opacity slider".
   - The spec 050 block drops its Save dialog test. It keeps the ADR 0001 Status test.
   - In `style.test.ts`, the spec 036 test drops its two README assertions. It keeps the `#status [hidden]` check.
   - Test names follow what each test still checks.
2. **Titles per platform.** `labelButtons` takes `mac`, as `initUndo` does, and passes it to `keyLabel` and `ariaKey`.
3. **Hints.** A button's title is `<action> (<first key>)`, then `\n<hint>` when the entry has a hint.
   - A hint may contain `\n`, so the title can run to more than two lines.
   - The help dialog shows no hints: its rows are the keys and the action (`initHelp`).
   - The docstrings in `ui/shortcuts.ts` and `ui/help.ts` cite spec 057 instead of "(local change)". Where they say "second line", they say "the lines after the key".
   - Four `hint` values change (Decided 3). Every other hint stays byte-for-byte.
     - `paint`: `"Left Drag: paints the selected class\nRight Drag: removes the selected class"`
     - `erase`: `"Removes the selected class"`
     - `smart`: `"Click an object to create an AI-generated mask. More clicks add to it, Shift+click excludes, Enter applies."`
     - `fill`: `"Click an area to change every connected pixel of the same class to the selected class."`
4. **E2E undo key.** Every `keyboard.press("Control+z")` becomes `"ControlOrMeta+z"`. Presses of `Control+y` and `Control+Shift+Z` stay, since both are bound on Mac. Checked against Playwright 1.64.1 (`playwright-core/lib/coreBundle.js`):
   - `ControlOrMeta` becomes Meta when `process.platform` is darwin.
   - `Meta+KeyZ` runs the native `undo:` in a text field.
   - The Desktop Chrome device's user-agent override sends no `platform`. The page's `navigator.platform`, and so `IS_MAC`, stays the host's.
5. **Docs.** Specs 036, 037, 039, 046 and 050 each get a one-line "Amended by spec 057" note. The notes for 036, 037 and 050 say the README no longer has to contain that wording (Decided 1). CHANGELOG gets an entry at merge.

**Out of scope:** any behaviour change other than scope 3's hint texts, any README edit, renaming tests whose names say "Ctrl+Z", Mac CI, and approving spec 054.

## Interfaces
- `ui/help.ts`: `labelButtons(byId: (id: string) => HTMLElement | null, mac = IS_MAC): void`.
- No `core/` change.

## Acceptance criteria
1. **Unit:**
   - `README.md` is byte-equal to main's.
   - `readme.test.ts` and `style.test.ts` no longer assert "**Redo**", "clear **Show** (H)", "the opacity slider beside it" or "On Chrome and Edge the Save dialog".
   - Both files still assert the absence of "shows the labels again, and the opacity slider", ADR 0001's Status naming ADR 0034, and that style.css has no `#status [hidden]` rule, and those assertions pass.
2. **Unit (shortcuts.test.ts):**
   - With `mac` false, `#redo`'s title's first line is `Redo (Ctrl+Shift+Z)` and its `aria-keyshortcuts` is `Control+Shift+Z Control+Y`. `#undo`'s first line is `Undo (Ctrl+Z)`.
   - With `mac` true, they are `Redo (Cmd+Shift+Z)`, `Meta+Shift+Z Control+Y` and `Undo (Cmd+Z)`.
   - No assertion in the file depends on `IS_MAC` or the host's `navigator.platform`.
3. **Unit:** for every `SHORTCUTS` entry with a `button`, the title is exactly `` `${action} (${keyLabel(keys[0], mac)})` ``, followed by `` `\n${hint}` `` when the entry has a hint. Without a hint, the title has no newline.
4. **E2E:** the four title checks in Decisions compare the whole title with `<action> (<key>)\n<hint>`, using the hint from `SHORTCUTS`.
5. **E2E:** no file in `tests/e2e/` contains `"Control+z"`. Spec 010 criterion 3, spec 046 criterion 5 and spec 049 criterion 4 pass on macOS.
6. `npm run check` has 0 failures on macOS and on Linux or Windows.
7. `npm run e2e` has 0 failures on macOS (the tester runs the full suite). A failure that scopes 3-4 don't explain goes back to the architect.
8. **Docs:** specs 036, 037, 039, 046 and 050 each have the scope 5 note.
9. **Unit (scope 3):**
   - The `paint`, `erase`, `smart` and `fill` hints equal the four strings in scope 3 exactly.
   - `#mode-paint`'s title, split on `\n`, gives exactly `["Paint (B)", "Left Drag: paints the selected class", "Right Drag: removes the selected class"]`.
   - No hint has a space before or after a `\n`. Every other hint equals its value on main.
   - The `#help` list's text contains none of the hints.
