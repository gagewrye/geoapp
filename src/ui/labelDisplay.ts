import type { Map as MapLibreMap } from "maplibre-gl";
import { viewBox } from "../core/imagery";
import type { LabelStore } from "../core/labelStore";
import { cellBuckets, PREVIEW_MAX_SIDE, previewCells, type MaskPreview } from "../core/maskPreview";
import { BASE_OVERLAY_DENSITY, boxKeys, LABEL_OVERLAYS, overlayKeys } from "../core/overlays";
import { pixelAt } from "../core/pixel";
import type { Grid } from "../core/types";
import { TASK_BUDGET_MS } from "../io/yieldTask";
import { LabelOverlays } from "../map/labelOverlay";
import { MaskLayer, type PreviewGrid } from "../map/maskLayer";

/** The labels on the map (specs 003, 014, 048, ADR 0033): every label on the preview-resolution `mask` layer, and at most LABEL_OVERLAYS stored tiles in view as full-resolution overlays over it. */
// Changed tiles are redrawn once per frame. Which tiles have overlays (the wanted keys) is worked out again when
// the view settles and after each redraw; missing ones are added centre first, a few per frame, and an unwanted
// overlay stays until its room is needed, the least recently wanted going first.
// Local change (not upstream): zoomed in (BASE_OVERLAY_DENSITY), the unedited mask tiles in view get overlays too, read
// from the mask through readBase as they come into view; zoomed out, those overlays go and the preview shows again.
export function labelDisplay(map: MapLibreMap, store: () => LabelStore, colours: () => string[],
  readBase?: (key: string) => Promise<Uint8Array | null>) {
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
  // the mask's own tiles: those an overlay shows, those read (least recently used first), and those whose read failed
  const baseShown = new Map<string, Uint8Array>(), baseCache = new Map<string, Uint8Array>(), baseFailed = new Set<string>();
  const BASE_READS = 4, BASE_CACHE = 2 * LABEL_OVERLAYS; // reads in flight, and tiles kept (64 KiB each)
  let zoomed = false, recolour = false, reading = 0, gen = 0; // gen: reads started before the mask or raster changed are dropped
  let pending = new Set<string>();

  /** Raster pixels per CSS pixel at the view's centre; NaN where the view doesn't project. */
  function density(g: Grid): number {
    const c = map.project(map.getCenter());
    const a = map.unproject([c.x - 50, c.y]), b = map.unproject([c.x + 50, c.y]);
    const [ax, ay] = pixelAt(g, a.lng, a.lat), [bx, by] = pixelAt(g, b.lng, b.lat);
    return Math.hypot(bx - ax, by - ay) / 100;
  }

  /** Takes the mask's own tiles off the map, so the preview shows there again. */
  function dropBase(): void {
    for (const key of baseShown.keys()) { overlays?.drop(key); mask?.hide(key, false); maskDirty = true; }
    baseShown.clear();
  }

  /** Forgets every mask tile read and in flight (the mask or the raster changed). */
  function resetBase(): void {
    baseCache.clear();
    baseFailed.clear();
    pending = new Set();
    reading = 0;
    gen++;
  }

  /** Reads the wanted mask tiles not read yet, centre first, a few at a time; each one read is drawn by the next fill. */
  function readBases(): void {
    if (!readBase || !zoomed || !shown || !overlays) return;
    const s = store(), g = gen, mine = pending;
    for (const key of wanted) {
      if (reading >= BASE_READS) return;
      if (overlays.has(key) || s.tiles.has(key) || baseCache.has(key) || baseFailed.has(key) || mine.has(key)) continue;
      reading++;
      mine.add(key);
      const done = (labels: Uint8Array | null) => {
        if (g !== gen) return;
        reading--;
        mine.delete(key);
        if (labels) {
          baseCache.set(key, labels);
          for (const old of baseCache.keys()) { if (baseCache.size <= BASE_CACHE) break; baseCache.delete(old); }
        } else baseFailed.add(key); // not read again: a stroke there reports the file, as before
        scheduleFill();
      };
      readBase(key).then(done, () => done(null));
    }
  }

  /** A raster's preview grid: its cells (pc, computed here unless given) and their buckets. */
  const buildGrid = (g: Grid, pc = previewCells(g, PREVIEW_MAX_SIDE)): PreviewGrid => ({ ...pc, buckets: cellBuckets(pc.cells, g) });
  let preparing = false;

  /** Builds the preview grid in two background tasks of about 30 ms each, once per raster (the mask layer builds it at once if needed sooner). */
  function prepare(): void {
    const g = grid;
    if (!g || previewGrid || preparing) return;
    preparing = true;
    setTimeout(() => {
      if (grid !== g || previewGrid) return;
      const pc = previewCells(g, PREVIEW_MAX_SIDE);
      setTimeout(() => { if (grid === g && !previewGrid) previewGrid = buildGrid(g, pc); }, 0);
    }, 0);
  }

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
    // a raster no larger than the preview already shows pixel for pixel
    zoomed = !!box && !!base && !!readBase && Math.max(grid.width, grid.height) > PREVIEW_MAX_SIDE && density(grid) < BASE_OVERLAY_DENSITY;
    wanted = box ? overlayKeys(zoomed ? boxKeys(box) : store().tiles.keys(), box, LABEL_OVERLAYS) : [];
    if (!zoomed) dropBase();
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
    baseShown.delete(worst);
    mask?.hide(worst, false);
    maskDirty = true;
  }

  /** Adds wanted overlays, centre first, until this task's budget is spent; the rest wait for the next frame. */
  function fill(): void {
    if (!overlays) return;
    const s = store(), c = colours(), start = performance.now();
    for (const key of wanted) {
      if (overlays.has(key)) continue;
      const stored = s.tiles.get(key), tile = stored ?? (zoomed ? baseCache.get(key) : undefined);
      if (!tile) continue;
      if (performance.now() - start > TASK_BUDGET_MS) { scheduleFill(); return; }
      if (overlays.size >= LABEL_OVERLAYS) evict();
      overlays.update(key, tile, c);
      if (!stored) { baseShown.set(key, tile); baseCache.delete(key); baseCache.set(key, tile); } // used again: last to leave the cache
      mask?.hide(key, true);
      maskDirty = true;
    }
    readBases();
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
      if (tile) { overlays.update(key, tile, c); baseShown.delete(key); }
      else if (baseShown.has(key)) continue; // unedited, and its overlay shows the mask's own tile already
      else {
        const own = zoomed ? baseCache.get(key) : undefined; // an Undo gave the tile back to the mask
        if (own) { overlays.update(key, own, c); baseShown.set(key, own); }
        else { overlays.drop(key); mask?.hide(key, false); maskDirty = true; }
      }
    }
    if (recolour) for (const [key, t] of baseShown) overlays.update(key, t, c);
    recolour = false;
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
    baseShown.clear();
    recolour = false;
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
      recolour ||= repaintMask;
      if (!frame) frame = requestAnimationFrame(flush);
    },
    /** The view settled (spec 027's signal; the first comes once the preview is drawn): overlays follow it. */
    settled(): void {
      prepare();
      if (!shown || !overlays) return;
      want();
      fill();
      paintMask();
    },
    /** New imagery: no overlays, mask or base. */
    open(g: Grid): void {
      takeDown();
      resetBase();
      base = null;
      shown = true;
      grid = g;
      previewGrid = null;
      preparing = false;
      overlays = new LabelOverlays(map, g);
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
      dropBase(); // another mask's tiles
      resetBase();
      refill();
    },
    /** Resolves once no overlay redraw or fill is scheduled, no mask tile read is in flight and no quads are queued (specs 071, 072). */
    idle(): Promise<void> {
      return new Promise<void>((resolve) => {
        const check = () => (frame || fillFrame || reading > 0 || overlays?.busy ? requestAnimationFrame(check) : resolve());
        check();
      });
    },
    /** The mask layer's preview values (for tests). */
    previewValues: () => mask?.values ?? null,
  };
}

/** Resolves once the view isn't settling (imagery's debounce), then once the display is idle (e2e: __geoapp.overlaysIdle, spec 072). */
export function overlaysIdle(settling: () => boolean, idle: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = () => { if (settling()) requestAnimationFrame(check); else void idle().then(resolve); };
    check();
  });
}
