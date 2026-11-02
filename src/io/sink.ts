import type { Sink } from "./source";

type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[]; startIn?: FileSystemHandle }) =>
  Promise<{ createWritable(): Promise<Sink> }>;

/** Streamed output: Save dialog on Chromium (in `startIn`'s folder, if given), else an OPFS file downloaded when closed (ADRs 0001, 0034). */
export async function openSink(name: string, startIn?: FileSystemHandle): Promise<Sink> {
  const picker = (globalThis as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    const types = [{ description: "GeoTIFF", accept: { "image/tiff": [".tif"] } }];
    // no id: an id only remembers folders the pickers chose, never the imagery's (ADR 0034)
    const handle = await picker(startIn ? { suggestedName: name, types, startIn } : { suggestedName: name, types });
    return handle.createWritable();
  }
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
  };
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
