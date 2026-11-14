import type { Sink } from "./source";

// Declared locally, as io/filePick.ts declares the open picker: TypeScript's DOM lib has no showDirectoryPicker
type DirPicker = (o: { mode: "readwrite"; startIn?: FileSystemHandle }) => Promise<FileSystemDirectoryHandle>;

const dirPicker = () => (globalThis as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;

/** A sink whose written size can be read back once closed (spec 074 scope 4). */
export type SizedSink = Sink & { size(): Promise<number> };

/** True where the browser has showDirectoryPicker (Chromium): Export writes into a chosen folder (ADR 0040). */
export const canPickFolder = (): boolean => typeof dirPicker() === "function";

/** A folder chosen for writing, opened in `startIn`'s folder when given (ADRs 0034, 0040); null if the picker was cancelled. */
export async function pickFolder(startIn?: FileSystemHandle): Promise<FileSystemDirectoryHandle | null> {
  const picker = dirPicker() as DirPicker;
  try {
    // called before any await: the picker needs the click's user activation; no id, as ADR 0034 says
    return await picker(startIn ? { mode: "readwrite", startIn } : { mode: "readwrite" });
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === "AbortError") return null;
    throw e;
  }
}

/** The folder's file of this name, or null when there is none; creates nothing. */
export async function existingFile(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(name);
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === "NotFoundError" || (e as { name?: unknown } | null)?.name === "TypeMismatchError") return null;
    throw e;
  }
}

/** Streams into dir/name through createWritable's swap file: an existing file changes only on a complete close (WHATWG File System). */
// A file this export created is removed again on abort, so a failed export leaves no empty file behind
export async function folderSink(dir: FileSystemDirectoryHandle, name: string): Promise<SizedSink> {
  const existed = (await existingFile(dir, name)) !== null;
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable({ keepExistingData: false });
  return {
    write: (d) => w.write(d as Uint8Array<ArrayBuffer>),
    close: () => w.close(),
    async abort() {
      await w.abort();
      if (!existed) await dir.removeEntry(name).catch(() => {});
    },
    size: async () => (await handle.getFile()).size,
  };
}

/** ADR 0001's path for browsers without folder access: an OPFS file, downloaded once closed. A download never overwrites a file. */
export async function downloadSink(name: string): Promise<SizedSink> {
  const dir = await navigator.storage.getDirectory();
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  return {
    write: (d) => writable.write(d as Uint8Array<ArrayBuffer>),
    async close() {
      await writable.close();
      downloadBlob(await fileHandle.getFile(), name);
    },
    async abort() {
      await writable.abort();
      await dir.removeEntry(name);
    },
    size: async () => (await fileHandle.getFile()).size,
  };
}

/** Whether two handles are the same file (isSameEntry); false without a first handle, true when the browser can't tell. */
export async function sameFile(a: FileSystemHandle | null, b: FileSystemHandle): Promise<boolean> {
  if (!a) return false;
  try {
    return await a.isSameEntry(b);
  } catch {
    return true; // unknown counts as the same file, so Export refuses rather than risk the imagery or mask
  }
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
