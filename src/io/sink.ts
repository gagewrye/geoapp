import type { Sink } from "./source";

type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) =>
  Promise<{ createWritable(): Promise<Sink> }>;

/** Streamed output: Save dialog on Chromium, else an OPFS file downloaded when closed (ADR 0001). */
export async function openSink(name: string): Promise<Sink> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    const handle = await picker({ suggestedName: name, types: [{ description: "GeoTIFF", accept: { "image/tiff": [".tif"] } }] });
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
  };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
