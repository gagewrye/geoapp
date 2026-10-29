import { tileWindows } from "../../../src/core/grid";
import type { LabelStore } from "../../../src/core/labelStore";
import { effectiveTile, type MaskBase } from "../../../src/io/maskBase";
import type { RasterSource } from "../../../src/io/source";

/** Every window's effective tile (stored, else the mask's, else zeros) by key, as spec 014's `tile(key)` gives it. */
export async function effectiveTiles(imagery: RasterSource, l: { store: LabelStore; base?: MaskBase | null }): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const w of tileWindows(l.store.width, l.store.height)) out.set(`${w.x0},${w.y0}`, await effectiveTile(imagery, l.store, l.base ?? null, w));
  return out;
}
