# 062: Label kinds: tool groups and panel sections, with no behaviour change

**Status:** Accepted (2026-11-12). Gage took every recommended answer in specs 062–070 ("Take all recommendations"), as relayed by the orchestrator. **ADRs:** 0037 (Accepted: plain DOM, no framework). **Builds on specs 035, 054 and 056.** It is the first spec of the bounding-box series.

**Amended (2026-11-12, during implementation, agreed by the orchestrator):** criterion 5 allows one test edit. Scope 2's `#brush-group` wrapper takes the brush controls out of `#brush-panel`'s direct children, so `tests/e2e/tool-strip-tidy.spec.ts:20` (spec 056 criterion 1), which queries `#brush-panel > *`, finds none of them. Their DOM order, Tab order and positions are unchanged. This is a correction, not a scope change.

**Amended (2026-11-12, after review, a correction agreed by the orchestrator):** criterion 4 compares the layout before and after the change in the same page, instead of against a fixture recorded on macOS. That fixture failed on Linux CI by 1 px on `#brush-panel`'s height (run 43339686870). An assertion failure in a test this spec adds is not a reason for `@ci-skip`, and spec 060 criterion 7 forbids OS checks in e2e.

**Amended by spec 073 (2026-11-12):** criteria 1–4's tests were run during verification and not kept, per Gage's rule that only lasting regression tests are committed; 062 merged with one `initKinds` unit test. The `tool-strip-tidy` test that criterion 5 edited is deleted by spec 073.

**Request** (Gage, verbatim): "How about an object detection pipeline using bounding boxes. We can expand this tool to include more labelling features, but this would include an overhaul of the UI to accomodate"

**Series, in build order:**

| Spec | Adds | Depends on |
|---|---|---|
| 062 | label-kind structure (this spec) | none |
| 063 | box model, store and shared undo (ADR 0038): on main (PR #12, merged as 7032e4f), and a rebase of this branch brings it in | none |
| 064 | Box tool | 062 and 063 |
| 065 | boxes list | 064 |
| 066 | box persistence (built straight after 064) | 064 |
| 067 | Smart select to box | 064 |
| 068 | GeoJSON export | 064 |
| 069 | chip dataset with COCO (ADR 0039) | 068 |
| 070 | YOLO files in the same dataset | 069 |

## Decided (Gage, 2026-11-12: the recommended answers)
1. **Framework.** Plain DOM (ADR 0037). Preact was rejected: it would rewrite the 40 `ui/` modules and their e2e selectors.
2. **Where the kind switch goes.** At the top of the tool strip, so tools sit under their kind, not in the top bar.

**Goal:** The tool strip and side panel are grouped by label kind, so spec 064 adds Boxes, and later kinds, by registering one entry. Nothing visible changes in this spec.

## Scope
1. **Registry.** `ui/kinds.ts` exports `KINDS` with one entry, `mask`:
   - name "Masks";
   - modes `paint`, `erase`, `fill` and `polygon`;
   - groups `#tools-mask` and `#brush-group`;
   - section `#mask-view`.

   `pan` and `smart` are shared and belong to no kind.
2. **Markup.**
   - In `#brush-panel`, `#mode-paint` through `#mode-polygon` are wrapped in `<div id="tools-mask" class="tool-group" data-kind="mask">`.
   - The brush controls (+, size, −, slider) are wrapped in `<div id="brush-group" class="tool-group" data-kind="mask">`.
   - An empty `<div id="kinds" role="radiogroup" aria-label="Label type" hidden>` goes before `#mode-pan`.
   - In `#label-section`, the opacity row becomes `<div id="mask-view" class="row" data-kind="mask">`.

   Every existing id, and the DOM and Tab order of every existing control, are unchanged.
3. **Switching.** `initKinds` behaves as follows:
   - It renders one `button[role=radio]` per kind into `#kinds` (`#kind-<id>`, `aria-checked`). `#kinds` shows only when there are 2 or more kinds.
   - `setKind(id)` sets `hidden` on every other kind's groups and sections, and clears it on its own.
   - A mode chosen by button or key that belongs to another kind switches to that kind first. `ui/modes.ts` `setMode`, which every mode change goes through, calls it.
   - Switching kind from a mode of the old kind selects Pan. Pan and Smart are kept.
4. **CSS.** `.tool-group` stacks its children exactly as `#brush-panel` does now, with no extra gap. So no control moves.

**Out of scope:** any visible change, the Boxes kind (spec 064), new keys, top bar changes.

## Interfaces
- `ui/kinds.ts` (wiring):
  - `type KindId = "mask"` (spec 064 adds `"box"`);
  - `type LabelKind = { id: KindId; name: string; modes: readonly BrushMode[]; groups: readonly string[]; sections: readonly string[] }`;
  - `KINDS: readonly LabelKind[]`;
  - `initKinds({ kinds, mode, setMode }): { kind(): KindId; setKind(id: KindId): void; kindOf(m: BrushMode): KindId | null; follow(m: BrushMode): void }`. `follow` is what `setMode` calls.
- No `core/` change.

## Acceptance criteria
1. **Unit (ui/kinds, a fake two-kind registry `a` and `b` over fake DOM):**
   - `setKind("b")` hides `a`'s groups and sections and shows `b`'s. `aria-checked` follows.
   - `#kinds` is hidden with one kind and shown with two.
2. **Unit (same fake):**
   - `follow` with a mode of `b` while in `a` switches to `b`.
   - `setKind("b")` in a mode of `a` calls `setMode("pan")`.
   - In Pan or Smart the mode is kept.
3. **Unit (real `KINDS` and `index.html`):** every `BrushMode` is `pan`, `smart`, or in exactly one kind's modes. Every group and section id exists in `index.html`.
4. **E2E (1280×720, after open), one page, with no fixture, no OS check (spec 060 criterion 7) and no `@ci-skip`, so it runs on CI:**
   - `#kinds` is hidden.
   - **Wrapped.** Record `getBoundingClientRect()` of every element in `#tools` and `#side`, keyed by the element object, except `#kinds`, `#tools-mask` and `#brush-group`.
   - **Unwrapped.** In the same page, undo scope 2 in place:
     - move the children of `#tools-mask` and of `#brush-group` into their parent, at the wrapper's position and in their order, then remove both wrappers;
     - remove `#kinds`;
     - remove the `id` and `data-kind` of `#mask-view`.
   - **Compare.** Measure the same element objects again. Each of x, y, width and height matches the wrapped measurement within 0.5 px.
   - The earlier fixture (recorded on macOS at 4a54545) and its test are deleted.
   - Before the change, the implementer runs the fixture test once on CI and puts its full list of mismatches in the PR description. That shows whether they are only text heights (run 43339686870 showed 1 px on `#brush-panel`'s height).
5. **E2E:** the existing suite passes with exactly one test edit.
   - In `tests/e2e/tool-strip-tidy.spec.ts` line 20, the selector `#brush-panel > *` becomes `#brush-panel *`.
   - The id filter, `ORDER` and both assertions (DOM order, then tops increasing) are unchanged, so spec 056 criterion 1 is checked as before.
   - No other test changes.
6. `npm run check` passes.
7. **Docs:** a CHANGELOG entry that names criterion 5's test edit and why it is needed. The README is unchanged, since nothing visible changes.
