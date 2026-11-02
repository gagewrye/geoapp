import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { cellBuckets, previewCells, PREVIEW_MAX_SIDE, type MaskPreview } from "../../../src/core/maskPreview";
import type { Grid } from "../../../src/core/types";
import { labelDisplay } from "../../../src/ui/labelDisplay";

// Tester edge cases for spec 048 criterion 5 and scope 3: partial edge tiles, erasing an overlaid tile, empty
// stores, views off the raster, recolour and hide/redraw never overlaying past 256.

const PX = 1e-4;
const COLOURS = ["#ff0000", "#00ff00", "#0000ff"];
type Bounds = [number, number, number, number];
const gridOf = (w: number, h: number): Grid => ({ epsg: 4326, gt: [10, PX, 0, 1, 0, -PX], width: w, height: h });
const bounds = (x0: number, y0: number, x1: number, y1: number): Bounds => [10 + x0 * PX, 1 - y1 * PX, 10 + x1 * PX, 1 - y0 * PX];

let frames: Map<number, () => void>;
let nextFrame = 1;

function fakeMap(view: { b: Bounds }) {
  const layers: string[] = [];
  const sources = new Map<string, unknown>();
  const map = {
    addSource: (id: string, spec: unknown) => { sources.set(id, spec); },
    getSource: (id: string) => (sources.has(id) ? { setWarp: () => {}, play: () => {}, pause: () => {} } : undefined),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (l: { id: string }, before?: string) => { layers.splice(before && layers.includes(before) ? layers.indexOf(before) : layers.length, 0, l.id); },
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    removeLayer: (id: string) => { layers.splice(layers.indexOf(id), 1); },
    getLayersOrder: () => [...layers],
    getStyle: () => ({ layers: layers.map((id) => ({ id })) }),
    getBounds: () => ({ getWest: () => view.b[0], getSouth: () => view.b[1], getEast: () => view.b[2], getNorth: () => view.b[3] }),
  };
  const overlaid = () => new Set(layers.filter((id) => id.startsWith("label-")).map((id) => id.slice(6)));
  return { map: map as unknown as MapLibreMap, layers, overlaid };
}

let peak = 0;
function runFrames(overlaid: () => Set<string>) {
  for (let i = 0; frames.size && i < 10_000; i++) {
    const [id, f] = frames.entries().next().value!;
    frames.delete(id);
    f();
    peak = Math.max(peak, overlaid().size);
  }
}

beforeEach(() => {
  frames = new Map();
  peak = 0;
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => { const id = nextFrame++; frames.set(id, f); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData: () => {} }) }) });
  vi.stubGlobal("ImageData", class { data: Uint8ClampedArray; constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

function mount(grid: Grid, s: LabelStore, b: Bounds) {
  const view = { b };
  const m = fakeMap(view);
  const display = labelDisplay(m.map, () => s, () => COLOURS);
  display.open(grid);
  return { ...m, view, display };
}

/** Preview pixel indices whose source pixel is in the tile at key. */
function pixelsOf(grid: Grid, key: string): number[] {
  const [x0, y0] = key.split(",").map(Number) as [number, number];
  const { cells } = previewCells(grid, PREVIEW_MAX_SIDE);
  const out: number[] = [];
  for (let p = 0; p < cells.length / 2; p++) {
    const c = cells[2 * p]!, r = cells[2 * p + 1]!;
    if (c >= x0 && c < x0 + 256 && r >= y0 && r < y0 + 256) out.push(p);
  }
  return out;
}

describe("labelDisplay edge cases (spec 048, tester)", () => {
  it("an empty store with no base adds no mask layer and no overlays", () => {
    const grid = gridOf(700, 600), s = emptyStore(700, 600);
    const t = mount(grid, s, bounds(0, 0, 700, 600));
    t.display.redraw([]);
    t.display.settled();
    runFrames(t.overlaid);
    expect(t.layers).toEqual([]);
    expect(t.display.previewValues()).toBeNull();
  });

  it("partial edge tiles get overlays; erasing an overlaid edge tile drops its overlay and the preview shows the base there again", () => {
    const grid = gridOf(700, 600), s = emptyStore(700, 600); // 3 x 3 tiles, the last column 188 px, the last row 88 px
    const pc = previewCells(grid, PREVIEW_MAX_SIDE);
    const base: MaskPreview = { values: new Uint8Array(pc.width * pc.height).fill(2), width: pc.width, height: pc.height, corners: pc.corners, buckets: cellBuckets(pc.cells, grid) };
    const baseCopy = base.values.slice();
    for (let y = 0; y < 600; y += 256) for (let x = 0; x < 700; x += 256) s.tiles.set(`${x},${y}`, new Uint8Array(65536).fill(3));
    const t = mount(grid, s, bounds(0, 0, 700, 600));
    t.display.setMask(base);
    t.display.redraw(s.tiles.keys());
    runFrames(t.overlaid);
    expect(t.overlaid()).toEqual(new Set(s.tiles.keys()));
    expect(t.layers).toContain("mask");

    const edge = "512,512", pix = pixelsOf(grid, edge);
    expect(pix.length).toBeGreaterThan(0);
    const values = t.display.previewValues()!;
    expect(pix.every((p) => values[p] === 3)).toBe(true);
    s.tiles.delete(edge);
    t.display.redraw([edge]);
    runFrames(t.overlaid);
    expect(t.overlaid().has(edge)).toBe(false);
    expect(pix.every((p) => values[p] === 2)).toBe(true);
    expect(base.values).toEqual(baseCopy); // the base's own values are never written
  });

  it("a view off the raster overlays nothing and keeps the mask layer", () => {
    const grid = gridOf(700, 600), s = emptyStore(700, 600);
    s.tiles.set("0,0", new Uint8Array(65536).fill(1));
    const t = mount(grid, s, bounds(5000, 5000, 6000, 6000));
    t.display.redraw(s.tiles.keys());
    runFrames(t.overlaid);
    expect(t.overlaid().size).toBe(0);
    expect(t.layers).toEqual(["mask"]);
    expect(pixelsOf(grid, "0,0").every((p) => t.display.previewValues()![p] === 1)).toBe(true);
  });

  it("a recolour of 400 stored tiles and a hide then redraw never overlay more than 256", { timeout: 60_000 }, () => {
    const side = 24 * 256, grid = gridOf(side, side), s = emptyStore(side, side);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) s.tiles.set(`${x * 256},${y * 256}`, new Uint8Array(65536).fill(1));
    const t = mount(grid, s, bounds(0, 0, side, side));
    t.display.redraw(s.tiles.keys());
    runFrames(t.overlaid);
    const first = t.overlaid();
    expect(first.size).toBe(256);
    t.display.redraw(s.tiles.keys(), true); // recolour acts only on existing overlays
    runFrames(t.overlaid);
    expect(t.overlaid()).toEqual(first);
    t.display.hide();
    expect(t.layers).toEqual([]);
    t.display.redraw(s.tiles.keys());
    t.display.setMask(null);
    runFrames(t.overlaid);
    expect(t.overlaid()).toEqual(first);
    expect(t.layers.filter((id) => id === "mask")).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(256);
  });
});
