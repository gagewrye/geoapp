# 0036: The imported mask is read from the app's OPFS copy once it is saved

**Status:** Accepted (Gage approved in advance, 2026-11-14, as relayed by the orchestrator), with spec 055. Amends ADR 0018 ("the mask must stay unchanged on disk for the session") and ADR 0025, whose copy was until now used only on restore.

**Context:** ADR 0018 reads the user's file on demand, so an export, a script or a sync tool changing that file breaks painting and export (`NotReadableError`, W3C File API). ADR 0025 already streams each import into `bases/` in OPFS.

**Decision:** When that copy is written and its size equals the source's, the live `MaskBase.file` is swapped to `openLabelFile(copy)`. Until then, and when no copy can be kept (quota), the user's file stays the base, and spec 055 refuses exports over it.

**Consequences:** No dependency and no extra disk. After the copy, the user may move, edit or overwrite their file. A file `<input>` import is protected only once its copy is written, usually within seconds.
