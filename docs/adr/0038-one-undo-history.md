# 0038: One undo history for mask tiles and boxes

**Status:** Accepted (Gage, 2026-11-12, as relayed by the orchestrator), with spec 063. Amends ADR 0015.

**Context:** Undo keeps per-stroke copies of label tiles, within `UNDO_BYTES` = 32 MiB and `UNDO_STEPS` = 50 (ADR 0015, specs 037 and 048). A box (spec 063) is a record of six integers. Options: (a) one history whose entries hold both tile copies and box before-states; (b) a second history for boxes, used while the Boxes tools show; (c) a command log replayed from a base state, which ADR 0015 already rejected for tiles.

**Decision:** (a). An entry is `{ tiles, boxes }`, and Ctrl+Z reverts the newest entry of either kind. Each box before-state counts 48 bytes against `UNDO_BYTES`, and each entry counts one step. A later label type adds its own before-state map to the entry.

**Consequences:** No dependency. Undo follows the order of the user's edits, so with the Masks tools showing, Ctrl+Z can remove a box. Boxes stay drawn in both label types, so the change is visible. Opening a raster, an import and a restore clear both kinds of entry, as they clear tiles today.
