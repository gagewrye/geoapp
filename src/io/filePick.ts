// Declared locally, as io/sink.ts declares the save picker: TypeScript's DOM lib has neither (ADR 0034)
type OpenPicker = (o: { types: { description: string; accept: Record<string, string[]> }[]; startIn?: FileSystemHandle }) => Promise<FileSystemFileHandle[]>;

const openPicker = () => (globalThis as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;

/** True where the browser has showOpenFilePicker (Chromium); elsewhere the file input opens imagery. */
export function canPickFiles(): boolean {
  return typeof openPicker() === "function";
}

/** The chosen GeoTIFF's handle, or null if the picker was cancelled; `startIn` opens it in that file's folder (specs 050, 053). */
export async function pickRaster(startIn?: FileSystemHandle): Promise<FileSystemFileHandle | null> {
  const picker = openPicker() as OpenPicker;
  try {
    // called before any await: the picker needs the click's user activation
    const types = [{ description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } }];
    const [handle] = await picker(startIn ? { types, startIn } : { types });
    return handle ?? null;
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === "AbortError") return null;
    throw e;
  }
}
