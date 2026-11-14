# Geoplatform

Local-first browser app for labelling geospatial imagery. User data (local rasters, labels) never leaves the user's device. We host only static files.

## Stack
- TypeScript (strict), Vite, MapLibre GL, geotiff.js
- Vitest (unit), Playwright (e2e)
- No UI framework until one is justified in an ADR.

## Layout
```
src/
  core/    pure logic: projections, preview warping and decimation, nodata masks, classes, label store and brush, label quads, undo, label seeding, WASD steps, smart-select windows and masks, fills and polygons, boxes, chip grids and annotation formats (GeoJSON, COCO, YOLO). No DOM.
  io/     raster read/write, file access
  map/    MapLibre layers, brush, navigation
  ui/     DOM wiring only
tests/    unit (mirrors src/), e2e/
shelf/    AlphaEarth and training code, unused and outside npm run check (spec 013); reviving any of it needs a spec
docs/
  specs/  one per feature, NNN-name.md
  adr/    one per decision, NNNN-name.md
```

## Workflow
spec (architect) → **Gage approves spec + ADRs** → code + tests (implementer) → verify (tester) → review (reviewer) → CI green → merge.
No step is skipped. Reviewer has final say on code; Gage has final say on scope.

## Orchestrator (main session)
The main session routes work between agents. It does not write specs, source, tests, or reviews itself.
- Pass each agent only its inputs:
  - architect: request + CLAUDE.md + existing specs/ADRs
  - implementer: approved spec path + ADR paths
  - tester: spec path + implementer's report
  - reviewer: spec path + `git diff main...HEAD` + tester's report. Never the implementer's reasoning.
- Failure loops: tester FAIL or reviewer CHANGES REQUESTED → back to implementer with that report verbatim. Spec wrong → back to architect.
- Escalate to Gage: open questions, ADRs, scope changes, anything after 2 failed loops.
- Branch protection on main requires a PR and the `ci` check (admins can bypass).
- Every e2e test runs in 15 s or less on CI; Playwright's CI timeout enforces it. A test that times out or runs slower is a badly made test, whatever the PR changed: the implementer refactors or splits it (cheaper fixture, read only what it checks, wait on app state or events rather than time or pixels, or independent smaller tests). Never skip, tag out or retry it. Fix it in the same PR if it is one or two tests; otherwise escalate to Gage.
- A test that fails by assertion goes back to the implementer as a normal failure.

## Code rules
- `core/` is pure and fully unit-tested. Math lives here, nowhere else.
- Rasters are processed tile by tile. Never load a full raster into memory.
- Small modules; a file over ~200 lines needs a reason.
- No dependency added without an ADR.
- `npm run check` (lint + typecheck + tests) passes before review.
- Commit only lasting regression tests. A check that proves a change once (layout unchanged, doc text, edge cases a tester tried) is run during verification and not committed.

## Doc rules
- Write for a reader who exists. No doc without one.
- README: one page. Specs: one page. ADRs: ≤10 lines.
- Comments say why, not what. Docstrings: one line.
- Update docs in the same change as the code they describe.
