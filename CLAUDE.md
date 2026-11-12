# Geoplatform

Local-first browser app for labelling geospatial imagery. User data (local rasters, labels) never leaves the user's device. We host only static files.

## Stack
- TypeScript (strict), Vite, MapLibre GL, geotiff.js
- Vitest (unit), Playwright (e2e)
- No UI framework until one is justified in an ADR.

## Layout
```
src/
  core/   pure logic: projections, preview warping and decimation, nodata masks, classes, label store and brush, label quads, undo, label seeding, WASD steps, smart-select windows and masks. No DOM.
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
- If an e2e test fails on CI with a timeout (the test timeout, or an `expect`, `expect.poll` or locator timeout) and the PR doesn't change what that test covers, the orchestrator sends it to the implementer. The implementer appends ` @ci-skip` to its title and adds a CHANGELOG line naming the test and the run. Then CI is re-run.
- A test that fails by assertion rather than timeout goes back to the implementer as a normal failure, and so does a timeout in a test the PR's change touches. When it's unclear whether the PR touches the test, assume it does.

## Code rules
- `core/` is pure and fully unit-tested. Math lives here, nowhere else.
- Rasters are processed tile by tile. Never load a full raster into memory.
- Small modules; a file over ~200 lines needs a reason.
- No dependency added without an ADR.
- `npm run check` (lint + typecheck + tests) passes before review.

## Doc rules
- Write for a reader who exists. No doc without one.
- README: one page. Specs: one page. ADRs: ≤10 lines.
- Comments say why, not what. Docstrings: one line.
- Update docs in the same change as the code they describe.
