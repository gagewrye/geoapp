# 0034: Open imagery with showOpenFilePicker so the export starts in its folder

**Status:** Accepted (Gage waived review, 2026-11-02, as relayed by the orchestrator), with spec 050. Amends ADR 0001 (the sink takes an optional `startIn`). Checked against the WICG File System Access draft of 10 October 2025, MDN `showSaveFilePicker` (modified 2026-09-11), and Chrome's File System Access guide. Chrome version: to be recorded by spec 050 criterion 6.

**Context:** Gage keeps each chunk in its own folder. Export's Save dialog opens in the folder the origin's pickers last used, not the imagery's, so labels land in the wrong chunk. An `<input type="file">` gives a `File` with no handle or path. The pickers' `startIn` accepts a `FileSystemHandle`, and for a file it opens in the parent folder, overriding `id`. Options: (a) on Chromium, open imagery through `showOpenFilePicker` and pass its handle as `startIn`; (b) give the save picker an `id`, which only remembers folders the pickers chose, so it never learns the imagery's; (c) leave it, and show the saved file name.

**Decision:** (a). Where `showOpenFilePicker` exists, it replaces the input's chooser; elsewhere the input stays. No `id` is passed. Picker types are declared locally, as `io/sink.ts` already does.

**Consequences:** No dependency. There are two open paths: the picker on Chromium, and the input in Firefox and Safari (which have neither picker, so they keep today's folders) and in e2e via `setInputFiles`. Picker opens need a user gesture, so nothing may be awaited before the call. A handle is held only for the session.
