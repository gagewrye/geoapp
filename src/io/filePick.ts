// Declared locally, as io/sink.ts declares the save picker: TypeScript's DOM lib has neither (ADR 0034)
type OpenPicker = (o: { types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>;

const openPicker = () => (globalThis as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;

/** True where the browser has showOpenFilePicker (Chromium); elsewhere the file input opens imagery. */
export function canPickFiles(): boolean {
  return typeof openPicker() === "function";
}

/** The chosen GeoTIFF's handle, or null if the picker was cancelled (spec 050). */
export async function pickRaster(): Promise<FileSystemFileHandle | null> {
  const picker = openPicker() as OpenPicker;
  try {
    // called before any await: the picker needs the click's user activation
    const [handle] = await picker({ types: [{ description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } }] });
    return handle ?? null;
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === "AbortError") return null;
    throw e;
  }
}
