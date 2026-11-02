import type { Map as MapLibreMap } from "maplibre-gl";
import { viewBox } from "../core/imagery";
import type { LabelStore } from "../core/labelStore";
import { cellBuckets, PREVIEW_MAX_SIDE, previewCells, type MaskPreview } from "../core/maskPreview";
import { LABEL_OVERLAYS, overlayKeys } from "../core/overlays";
import type { Grid } from "../core/types";
import { TASK_BUDGET_MS } from "../io/yieldTask";
import { LabelOverlays } from "../map/labelOverlay";
import { MaskLayer, type PreviewGrid } from "../map/maskLayer";

/** The labels on the map (specs 003, 014, 048, ADR 0033): every label on the preview-resolution `mask` layer, and at most LABEL_OVERLAYS stored tiles in view as full-resolution overlays over it. */
// Changed tiles are redrawn once per frame. Which tiles have overlays (the wanted keys) is worked out again when
// the view settles and after each redraw; missing ones are added centre first, a few per frame, and an unwanted
// overlay stays until its room is needed, the least recently wanted going first.
export function labelDisplay(map: MapLibreMap, store: () => LabelStore, colours: () => string[]) {
  let grid: Grid | null = null;
  let overlays: LabelOverlays | null = null;
  let previewGrid: PreviewGrid | null = null; // built once per raster
  let mask: MaskLayer | null = null; // added once there is a base or a stored tile
  let base: Uint8Array | null = null; // the mask base's preview values, never written
  let shown = true; // false from hide() until the next redraw or setMask
  let maskDirty = false;
  const dirty = new Set<string>();
  let frame = 0, fillFrame = 0;
  let wanted: string[] = [];
  const lastWanted = new Map<string, number>();
  let tick = 0;

  const buildGrid = (g: Grid): PreviewGrid => {
    const pc = previewCells(g, PREVIEW_MAX_SIDE);
    return { ...pc, buckets: cellBuckets(pc.cells, g) };
  };

  /** The mask layer, made (and filled with every stored tile) when first needed; null while there's nothing to show. */
  function maskLayer(): MaskLayer | null {
    if (mask || !grid || (!base && !store().tiles.size)) return mask;
    mask = new MaskLayer(map, grid, (previewGrid ??= buildGrid(grid)));
    refill();
    for (const key of overlays?.keys() ?? []) mask.hide(key, true);
    return mask;
  }

  function refill(): void {
    if (!mask) return;
    mask.setBase(base);
    for (const [key, t] of store().tiles) mask.fill(key, t);
    maskDirty = true;
  }

  /** The stored tiles in view that should have overlays, centre first. */
  function want(): void {
    if (!grid) return;
    const b = map.getBounds();
    const box = viewBox(grid, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    wanted = box ? overlayKeys(store().tiles.keys(), box, LABEL_OVERLAYS) : [];
    tick++;
    for (const key of wanted) lastWanted.set(key, tick);
  }

  /** The overlay to drop for a new one: the least recently wanted that isn't wanted now. */
  function evict(): void {
    const now = new Set(wanted);
    let worst: string | null = null, at = Infinity;
    for (const key of overlays!.keys()) {
      const t = lastWanted.get(key) ?? -1;
      if (!now.has(key) && t < at) { worst = key; at = t; }
    }
    if (worst === null) return;
    overlays!.drop(worst);
    mask?.hide(worst, false);
    maskDirty = true;
  }

  /** Adds wanted overlays, centre first, until this task's budget is spent; the rest wait for the next frame. */
  function fill(): void {
    if (!overlays) return;
    const s = store(), c = colours(), start = performance.now();
    for (const key of wanted) {
      const tile = s.tiles.get(key);
      if (!tile || overlays.has(key)) continue;
      if (performance.now() - start > TASK_BUDGET_MS) { scheduleFill(); return; }
      if (overlays.size >= LABEL_OVERLAYS) evict();
      overlays.update(key, tile, c);
      mask?.hide(key, true);
      maskDirty = true;
    }
  }

  function paintMask(): void {
    if (mask && maskDirty) mask.paint(colours());
    maskDirty = false;
  }

  function scheduleFill(): void {
    if (fillFrame) return;
    fillFrame = requestAnimationFrame(() => {
      fillFrame = 0;
      if (!shown) return;
      fill();
      paintMask();
    });
  }

  const flush = () => {
    frame = 0;
    if (!overlays) return;
    const s = store(), c = colours();
    const fresh = !mask && maskLayer() !== null; // a new layer holds every stored tile already
    for (const key of dirty) {
      const tile = s.tiles.get(key);
      if (mask && !fresh) { mask.fill(key, tile); maskDirty = true; }
      if (!overlays.has(key)) continue;
      if (tile) overlays.update(key, tile, c);
      else { overlays.drop(key); mask?.hide(key, false); maskDirty = true; }
    }
    dirty.clear();
    want();
    fill();
    paintMask();
  };

  const cancelFrames = () => {
    if (frame) cancelAnimationFrame(frame);
    if (fillFrame) cancelAnimationFrame(fillFrame);
    frame = fillFrame = 0;
  };

  /** Everything off the map and forgotten but the base, grid and preview grid. */
  const takeDown = () => {
    cancelFrames();
    dirty.clear();
    overlays?.clear();
    mask?.remove();
    mask = null;
    maskDirty = false;
    wanted = [];
    lastWanted.clear();
  };

  return {
    /** Redraws these tiles next frame; repaintMask also repaints the mask (a colour changed). */
    redraw(keys: Iterable<string>, repaintMask = false): void {
      shown = true;
      for (const k of keys) dirty.add(k);
      maskDirty ||= repaintMask;
      if (!frame) frame = requestAnimationFrame(flush);
    },
    /** The view settled (spec 027's signal): overlays follow it. */
    settled(): void {
      if (!shown || !overlays) return;
      want();
      fill();
      paintMask();
    },
    /** New imagery: no overlays, mask or base. */
    open(g: Grid): void {
      takeDown();
      base = null;
      shown = true;
      grid = g;
      previewGrid = null;
      overlays = new LabelOverlays(map, g);
    },
    /** Builds the raster's preview grid in two background tasks of about 30 ms each, after the open's own work. */
    prepare(): void {
      const g = grid;
      if (!g || previewGrid) return;
      setTimeout(() => {
        if (grid !== g || previewGrid) return;
        const pc = previewCells(g, PREVIEW_MAX_SIDE);
        setTimeout(() => { if (grid === g && !previewGrid) previewGrid = { ...pc, buckets: cellBuckets(pc.cells, g) }; }, 0);
      }, 0);
    },
    /** Computes these tiles' quads ahead, in idle time (spec 023 F5). */
    prefetch(keys: string[]): void { overlays?.prefetch(keys); },
    /** Removes every overlay and the mask from the map, keeping the store (spec 021's hold); a redraw and setMask draw them again. */
    hide(): void {
      takeDown();
      shown = false;
    },
    /** Shows this mask base under the stored tiles (null: none); call redraw with the stored keys after. */
    setMask(preview: MaskPreview | null): void {
      shown = true;
      base = preview?.values ?? null;
      refill();
    },
    /** The mask layer's preview values (for tests). */
    previewValues: () => mask?.values ?? null,
  };
}
