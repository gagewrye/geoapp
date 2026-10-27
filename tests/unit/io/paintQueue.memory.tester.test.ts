import { describe, expect, it } from "vitest";
import { footprint, strokeCells } from "../../../src/core/pixel";
import { MAX_LABEL_TILES, emptyStore, tileKeys, type LabelStore } from "../../../src/core/labelStore";
import { overlayIndex } from "../../../src/core/overlay";
import { fromLonLat } from "../../../src/core/crs";
import { TILE_SIZE, type Grid } from "../../../src/core/types";
import { tileWindows } from "../../../src/core/grid";
import { PaintQueue } from "../../../src/io/paintQueue";
import type { RasterSource } from "../../../src/io/source";
import { fakeSource } from "../helpers/sources";

// Tester: memory bounds of spec 003 / ADR 0010, checked structurally (window sizes, map sizes, byte
// lengths), never by sampling the heap. "Tile by tile" (CLAUDE.md): no read may exceed one tile.

type Probe = { reads: { x0: number; y0: number; width: number; height: number }[]; inFlight: number; maxInFlight: number; maxMasks: number; maxOverStored: number };

/** A source whose every read records its window and checks the queue's masks against the store at that moment. */
function probed(width: number, height: number, nodata: (c: number, r: number) => boolean, bandCount = 2) {
  const { source: inner } = fakeSource({ width, height, bandCount, nodata: -1 }, (b, c, r) => (b === bandCount - 1 && nodata(c, r) ? -1 : 3));
  const p: Probe = { reads: [], inFlight: 0, maxInFlight: 0, maxMasks: 0, maxOverStored: 0 };
  let q: PaintQueue | null = null;
  let store: LabelStore = emptyStore(width, height);
  const check = () => {
    if (!q) return;
    p.maxMasks = Math.max(p.maxMasks, q.masks.size);
    p.maxOverStored = Math.max(p.maxOverStored, q.masks.size - store.tiles.size);
  };
  const source: RasterSource = {
    meta: inner.meta,
    async readWindow(x0, y0, w, h) {
      p.reads.push({ x0, y0, width: w, height: h });
      p.inFlight++;
      p.maxInFlight = Math.max(p.maxInFlight, p.inFlight);
      check();
      await new Promise((r) => setTimeout(r, 0));
      try { return await inner.readWindow(x0, y0, w, h); } finally { p.inFlight--; }
    },
  };
  q = new PaintQueue(source, () => store, { applied: check, full() {}, busy() {}, error: (e) => { throw e; } });
  return { q, p, get store() { return store; }, set store(s: LabelStore) { store = s; } };
}

/** Push the stroke through the given cells, as the brush does (each cell's footprint, in order). */
function push(q: PaintQueue, store: LabelStore, cells: [number, number][], side: number, value = 1, erase = false) {
  const all = cells.flatMap((c, i) => (i === 0 ? [c] : strokeCells(cells[i - 1]!, c).slice(1)));
  for (const [c, r] of all) { const w = footprint(store, c, r, side); if (w) q.push({ w, value, erase }); }
}

const tileAligned = (w: { x0: number; y0: number; width: number; height: number }, W: number, H: number) =>
  w.x0 % TILE_SIZE === 0 && w.y0 % TILE_SIZE === 0 && w.width === Math.min(TILE_SIZE, W - w.x0) && w.height === Math.min(TILE_SIZE, H - w.y0);

// Generous timeouts: thousands of queued cells and hundreds of mask reads, slow under full-suite load.
describe("paint reads stay tile by tile (CLAUDE.md, criterion 8, tester)", { timeout: 60_000 }, () => {
  it("a long size-127 zig-zag over a 3000x2900 raster (partial edge tiles) reads only clipped 256x256-aligned windows, one at a time, never one twice while its mask is held", async () => {
    const W = 3000, H = 2900;
    const t = probed(W, H, (c, r) => (c * 7 + r * 3) % 97 === 0);
    push(t.q, t.store, [[-60, -60], [3050, 400], [10, 1200], [2999, 2899], [1500, 0]], 127);
    await t.q.idle();
    expect(t.p.reads.length).toBeGreaterThan(50);
    for (const w of t.p.reads) {
      expect(tileAligned(w, W, H), JSON.stringify(w)).toBe(true);
      expect(w.width * w.height).toBeLessThanOrEqual(TILE_SIZE * TILE_SIZE);
    }
    expect(t.p.maxInFlight).toBe(1);
    // a stored tile's mask is kept, so no stored tile is read twice
    const counts = new Map<string, number>();
    for (const w of t.p.reads) counts.set(`${w.x0},${w.y0}`, (counts.get(`${w.x0},${w.y0}`) ?? 0) + 1);
    for (const k of t.store.tiles.keys()) expect(counts.get(k), k).toBe(1);
  });

  it("masks held never exceed stored tiles + 8 (the last and next footprints), and at the end equal stored + the last footprint's", async () => {
    const W = 4096, H = 4096;
    const allNodataRow = (r: number) => r >= 2048 && r < 2304; // a tile row that is all nodata: masks there are never kept by a stored tile
    const t = probed(W, H, (_c, r) => allNodataRow(r));
    push(t.q, t.store, [[0, 2100], [4095, 2200], [0, 2280], [4095, 2100], [2000, 2300]], 127);
    await t.q.idle();
    expect(t.p.maxOverStored).toBeLessThanOrEqual(8);
    const last = footprint(t.store, 2000, 2300, 127)!;
    const want = new Set([...t.store.tiles.keys(), ...tileKeys(last)]);
    expect(new Set(t.q.masks.keys())).toEqual(want);
    // every mask is ceil(w*h/8) <= 8 KiB
    for (const m of t.q.masks.values()) expect(m.byteLength).toBeLessThanOrEqual(8192);
  });

  it(`at the cap (${MAX_LABEL_TILES} stored tiles) a stroke over 40 new tiles holds at most 264 masks and stores nothing new`, async () => {
    const W = 256 * 20, H = 256 * 16; // 320 tiles
    const t = probed(W, H, () => false, 1);
    // the stored tiles have masks too (as painting them would have left), built by painting one pixel each
    const cap = tileWindows(W, H).slice(0, MAX_LABEL_TILES);
    for (const w of cap) t.q.push({ w: { x0: w.x0 + 1, y0: w.y0 + 1, width: 1, height: 1 }, value: 2, erase: false });
    await t.q.idle();
    expect(t.store.tiles.size).toBe(MAX_LABEL_TILES);
    expect(t.q.masks.size).toBeLessThanOrEqual(MAX_LABEL_TILES + 4);
    const reads0 = t.p.reads.length;
    push(t.q, t.store, [[0, 256 * 13 + 120], [W - 1, 256 * 15 + 30], [0, 256 * 15 + 200]], 127);
    await t.q.idle();
    expect(t.p.reads.length).toBeGreaterThan(reads0 + 39);
    expect(t.store.tiles.size).toBe(MAX_LABEL_TILES);
    expect(t.p.maxMasks).toBeLessThanOrEqual(264);
    // 16 MiB of labels at most: each stored tile is its window's size
    let bytes = 0;
    for (const v of t.store.tiles.values()) bytes += v.byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_LABEL_TILES * 65536);
  });
});

describe("overlay index memory (ADR 0010, tester measurement)", () => {
  // ADR 0010 counts labels (16 MiB), masks (~2.1 MiB) and the canvases (~256 KiB each); the Int32
  // index each stored tile keeps (labelOverlay.ts) isn't in that bound. Measure it structurally.
  const [ux, uy] = fromLonLat(32633, 14, 47);
  const grids: Grid[] = [
    { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01], width: 1000, height: 1000 },
    { epsg: 32633, gt: [ux, 30, 0, uy, 0, -30], width: 600, height: 520 },
    { epsg: 4326, gt: [0, 0.017, 0, 90, 0, -0.017], width: 300, height: 600 }, // up to the pole
    { epsg: 3857, gt: [1e6, 10, 0, 5e6, 0, -10], width: 512, height: 512 }, // square in Mercator
  ];
  it("each tile's index is width*height Int32 with max side 256: at most 256 KiB, so up to 64 MiB at the cap", () => {
    let worst = 0;
    for (const g of grids) for (const w of tileWindows(g.width, g.height)) {
      const o = overlayIndex(w, g, TILE_SIZE);
      expect(o.index).toBeInstanceOf(Int32Array);
      expect(o.index.length).toBe(o.width * o.height);
      expect(Math.max(o.width, o.height)).toBeLessThanOrEqual(TILE_SIZE);
      worst = Math.max(worst, o.index.byteLength);
    }
    expect(worst).toBe(TILE_SIZE * TILE_SIZE * 4); // 262,144 bytes for a full tile square in Mercator
    expect(MAX_LABEL_TILES * worst).toBe(64 * 1024 * 1024);
  });

  it("a tile wholly beyond MAX_LAT gets a degenerate (zero-height) overlay that indexes nothing", () => {
    const g = grids[2]!; // rows 0..255 are 85.65N..90N, all beyond MAX_LAT
    const o = overlayIndex({ x0: 0, y0: 0, width: 256, height: 256 }, g, TILE_SIZE);
    expect(o.index.every((k) => k === -1)).toBe(true);
    expect(o.corners[0]![1]).toBe(o.corners[3]![1]); // N == S: nothing is drawn, as the spec says
  });
});
