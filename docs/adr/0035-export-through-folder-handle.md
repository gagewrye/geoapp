# 0035: Export writes through a folder handle, not the Save dialog

**Status:** Accepted (Gage approved in advance, 2026-11-14, as relayed by the orchestrator), with spec 055. Amends ADR 0001 (the Chromium sink) and ADR 0034 (`startIn` now goes to the folder picker). Checked against the WICG File System Access draft of 10 Oct 2025 and the WHATWG File System standard of 19 Oct 2026. The Chrome version is to be recorded by spec 055 criterion 9.

**Context:**
- `showSaveFilePicker` empties an existing chosen file before it returns (WICG: "Set entry's binary data to an empty byte sequence").
- So a failed export, or one that reads the chosen file, leaves 0 bytes. Gage lost 4 files this way.
- `FileSystemFileHandle.createWritable()` writes to a temporary file: "No changes are written to the actual file on disk until the stream has been closed" (WHATWG). Abort only releases the lock.
- `showDirectoryPicker({ mode: "readwrite", startIn })` changes no file, and a file `startIn` opens its parent (WICG).
- `isSameEntry` compares handles.

**Decision:**
- On Chromium, Export picks a folder, asks for the name with `prompt()`, checks the target, then writes with `getFileHandle(name, { create: true }).createWritable()`.
- `showSaveFilePicker` is no longer used.

**Consequences:**
- No dependency.
- An existing file changes only on a complete `close()`, and the imagery can be refused before any write.
- It costs one extra step: the user types the name, and Chrome asks for edit permission on the folder.
- A crash can leave a `.crswap` file behind.
- Firefox and Safari are unchanged.
