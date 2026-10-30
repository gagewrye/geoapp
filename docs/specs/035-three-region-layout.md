# 035: Three-region layout, collapsible panels, zoom to raster

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none (CSS grid, no framework). **Builds on specs 032–034.**

**Goal:** The map gets as much of the screen as possible. File actions, tools and classes each have one fixed place, and one key hides the side panels.

**Decided by Gage (2026-10-30), as drafted:** the research suggested Tab to collapse the panels. Tab is how keyboard users move focus (spec 009 and `labelKeys` rely on it), so the draft uses `\` (`e.code === "Backslash"`). Should it be Tab, accepting that conflict?

## Scope
1. `body` becomes a CSS grid:
   - rows: 40 px top bar, `1fr`, then spec 032's 28 px status bar;
   - columns: 56 px tool strip, `1fr` map, 260 px right panel.

   No element moves out of `index.html`. Existing ids are kept, so the e2e selectors still hold.
2. **Top bar `#topbar`:**
   - the title at 14 px bold;
   - Open GeoTIFF;
   - `#raster-info`, moved inline on one line and truncated with an ellipsis, with the full text in `title`;
   - Class map, Import labels and Export labels, shown once a raster opens.
3. **Left tool strip `#tools`:**
   - Pan, Paint, Erase (spec 033), drawn as icon or letter buttons with `aria-label` and `title` such as `Paint (B)`;
   - brush −, `#brush-size` showing only the number, then +;
   - `#brush-size-range`, vertical;
   - Undo.
4. **Right panel `#side`:**
   - Classes on top: `#classes` fills the remaining height and scrolls, and `#class-add` is in its header;
   - Labels below: `#show-labels` labelled `Show (H)`, and the opacity slider with its value beside it. `#label-opacity-text` now shows only `60%`.
5. The tool strip and the right panel are hidden until a raster opens, as `#brush-panel` is now. The map column then spans their width.
6. **Collapse.** `\` toggles `body.collapsed`, which sets both side columns to 0 so the map fills the width.
   - `map.resize()` runs after each change.
   - It is ignored in text fields, with Ctrl/Meta/Alt held, and before open.
   - The state is kept in `localStorage` (`geoplatform.collapsed`). A storage failure is ignored.
7. **Zoom to raster.** `Home`, or a ⌂ button added under MapLibre's zoom buttons as a custom control, fits the raster's bounds exactly as opening does (`padding: 40`, no animation).

**Out of scope:** resizable or draggable panels, themes, a minimap, mobile layout.

## Interfaces
- `map/preview.ts`: its fit becomes `fitRaster(map, bounds)`, used by both open and Home.
- `ui/layout.ts` (wiring): `initLayout({ map, open: () => boolean }): { opened(): void }`.
- No `core/` change.

## Acceptance criteria
1. **E2E, 1280×720 after open:**
   - `#topbar` is 40 px tall at the top.
   - `#tools` is at the left, `#side` at the right, and `#status` at the bottom.
   - The map canvas is (1280 − 56 − 260) × (720 − 40 − 28) px, ±2 px.
2. **E2E:**
   - Before open, `#tools` and `#side` are hidden and the canvas is 1280 px wide.
   - After open, `#import-labels` and `#export-labels` are inside `#topbar`, and the mode buttons are inside `#tools`.
3. **E2E:**
   - Pressing `\` makes the canvas 1280 px wide, and pressing it again restores the width.
   - After a reload and an open, the collapsed state is the one last set.
   - With focus in a class-name field, `\` types a backslash.
4. **E2E:**
   - Pan away and zoom in, then press `Home`: the map bounds equal those right after open, to 1e-6°.
   - The ⌂ button does the same.
5. **E2E:** with 60 classes, `#classes` scrolls inside `#side`, and `#side`'s Labels section stays visible.
6. **E2E:** every existing spec's e2e test passes unchanged, apart from selectors that depended on the sidebar's ancestry. Each changed selector is listed in the change.
7. `npm run check` passes.
