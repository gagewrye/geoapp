import type { Map as MapLibreMap } from "maplibre-gl";
import type { LabelStore } from "../core/labelStore";
import type { MaskPreview } from "../core/maskPreview";
import type { Grid } from "../core/types";
import { LabelOverlays } from "../map/labelOverlay";
import { MaskLayer } from "../map/maskLayer";

/** The labels on the map: one overlay per stored tile (spec 003) over the mask preview (spec 014), redrawn once per frame. */
// A redraw walks a whole tile, so tiles changed by many cells are redrawn once per frame. The mask is
// repainted when a key is added to or removed from the store, and on recolour.
export function labelDisplay(map: MapLibreMap, store: () => LabelStore, colours: () => string[]) {
  let overlays: LabelOverlays | null = null;
  let mask: MaskLayer | null = null;
  let maskDirty = false;
  const dirty = new Set<string>();
  let frame = 0;

  const flush = () => {
    frame = 0;
    const s = store(), c = colours();
    for (const key of dirty) {
      overlays?.update(key, s.tiles.get(key), c);
      if (mask?.setStored(key, s.tiles.has(key))) maskDirty = true; // a stored tile hides the mask there
    }
    dirty.clear();
    if (mask && maskDirty) mask.paint(c);
    maskDirty = false;
  };

  return {
    /** Redraws these tiles' overlays next frame; repaintMask also repaints the mask (a colour changed). */
    redraw(keys: Iterable<string>, repaintMask = false): void {
      for (const k of keys) dirty.add(k);
      maskDirty ||= repaintMask;
      if (!frame) frame = requestAnimationFrame(flush);
    },
    /** New imagery: no overlays and no mask. */
    open(grid: Grid): void {
      overlays?.clear();
      mask?.remove();
      mask = null;
      dirty.clear();
      overlays = new LabelOverlays(map, grid);
    },
    /** Shows this mask preview instead of the current one (null: none); call redraw with the stored keys after. */
    setMask(preview: MaskPreview | null): void {
      mask?.remove();
      mask = preview && new MaskLayer(map, preview);
      maskDirty = true;
    },
  };
}
