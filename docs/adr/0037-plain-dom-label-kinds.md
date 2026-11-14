# 0037: Plain DOM for the labelling UI, with label kinds as a registry

**Status:** Accepted (Gage, 2026-11-12, as relayed by the orchestrator), with spec 062.

**Context:** Bounding boxes (specs 062–070) add a label-type switch, a box list that may hold thousands of rows, and a dataset export form. Later types (points, polylines, rotated boxes) must fit without another overhaul. `src/ui/` is about 40 plain-DOM wiring modules that address elements by id, and the e2e suite selects those ids. The hard state (tiles, undo, map input) lives outside any view layer. Options (npm registry, checked 2026-11-12): (a) plain DOM; (b) Preact 11.2.0 (MIT, no dependencies, "4kB" per its README); (c) Lit 3.3.3 (BSD-3-Clause, 3 dependencies). Only the box list re-renders from state, and a keyed update by box id covers it.

**Decision:** (a). `ui/kinds.ts` holds one `LabelKind` per label type: its id, name, tool modes, tool group and panel sections. A new type adds an entry, a tool group, a panel section, a `core/` model and a `map/` layer. Pan, Smart select, classes, undo and the status bar stay shared. A second state-driven list or form reopens this in a new ADR.

**Consequences:** No dependency and no bundle growth. Markup stays in `index.html`, so ids and e2e selectors hold. The keyed row update in `ui/boxList.ts` is hand-written and needs its own tests.
