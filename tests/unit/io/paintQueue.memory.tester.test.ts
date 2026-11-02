import { describe, expect, it } from "vitest";
import { footprint, strokeCells } from "../../../src/core/pixel";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { TILE_SIZE } from "../../../src/core/types";
import { tileWindows } from "../../../src/core/grid";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import type { RasterSource } from "../../../src/io/source";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

// Tester: memory bounds of spec 003 / ADR 0010, checked structurally (window sizes, map sizes, byte
// lengths), never by sampling the heap. Since spec 023 (ADR 0021) a missing mask reads its 256-row band,
// once, and masks are kept for the raster's life: arrays of at most 8 KiB, none for uniform windows.

type Probe = { reads: { x0: number; y0: number; width: number; height: number }[]; inFlight: number; maxInFlight: number; maxMasks: number };

/** A source whose every read records its window and checks the queue's masks against the store at that moment. */
function probed(width: number, height: number, nodata: (c: number, r: number) => boolean, bandCount = 2) {
  const { source: inner } = fakeSource({ width, height, bandCount, nodata: -1 }, (b, c, r) => (b === bandCount - 1 && nodata(c, r) ? -1 : 3));
  const p: Probe = { reads: [], inFlight: 0, maxInFlight: 0, maxMasks: 0 };
  let q: PaintQueue | null = null;
  let store: LabelStore = emptyStore(width, height);
  const check = () => {
    if (!q) return;
    p.maxMasks = Math.max(p.maxMasks, q.masks.size);
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
  q = new PaintQueue(source, () => store, { applied: check, busy() {}, error: (e) => { throw e; } });
  return { q, p, get store() { return store; }, set store(s: LabelStore) { store = s; } };
}

/** Push the stroke through the given cells, as the brush does (each cell's footprint, in order). */
function push(q: PaintQueue, store: LabelStore, cells: [number, number][], side: number, value = 1, erase = false) {
  const all = cells.flatMap((c, i) => (i === 0 ? [c] : strokeCells(cells[i - 1]!, c).slice(1)));
  for (const [c, r] of all) { const w = footprint(store, c, r, side); if (w) q.push(cellOp(w, value, erase)); }
}

const band = (w: { x0: number; y0: number; width: number; height: number }, W: number, H: number) =>
  w.x0 === 0 && w.y0 % TILE_SIZE === 0 && w.width === W && w.height === Math.min(TILE_SIZE, H - w.y0);

// Generous timeouts: thousands of queued cells, slow under full-suite load.
describe("paint reads stay band by band (spec 023 F2, tester)", { timeout: 60_000 }, () => {
  it("a long size-127 zig-zag over a 3000x2900 raster (partial edge tiles) reads only clipped 256-row bands, one at a time, each once", async () => {
    const W = 3000, H = 2900;
    const t = probed(W, H, (c, r) => (c * 7 + r * 3) % 97 === 0);
    push(t.q, t.store, [[-60, -60], [3050, 400], [10, 1200], [2999, 2899], [1500, 0]], 127);
    await idle(t.q);
    expect(t.p.reads.length).toBe(Math.ceil(H / TILE_SIZE));
    for (const w of t.p.reads) expect(band(w, W, H), JSON.stringify(w)).toBe(true);
    expect(new Set(t.p.reads.map((w) => w.y0)).size).toBe(t.p.reads.length);
    expect(t.p.maxInFlight).toBe(1);
  });

  it("masks are kept for every window of a band read: arrays of at most 8 KiB, uniform windows with none", async () => {
    const W = 4096, H = 4096;
    const allNodataRow = (r: number) => r >= 2048 && r < 2304; // a tile row that is all nodata
    const t = probed(W, H, (_c, r) => allNodataRow(r));
    push(t.q, t.store, [[0, 2100], [4095, 2200], [0, 2280], [4095, 2100], [2000, 2300]], 127);
    await idle(t.q);
    const bands = new Set(t.p.reads.map((w) => w.y0));
    expect(t.q.masks.size).toBe(bands.size * (W / TILE_SIZE));
    for (const k of t.q.masks.keys()) {
      const m = t.q.masks.get(k)!;
      if (Number(k.split(",")[1]) === 2048) expect(m).toBe("none");
      else expect(m).toBe("all");
    }
    expect(t.q.masks.bytes).toBe(0);
  });

  it("with 256 stored tiles a stroke over 40 new tiles stores them, 64 KiB each (spec 048)", async () => {
    const W = 256 * 20, H = 256 * 16; // 320 tiles
    const t = probed(W, H, () => false, 1);
    const first = tileWindows(W, H).slice(0, 256);
    for (const w of first) t.q.push(cellOp({ x0: w.x0 + 1, y0: w.y0 + 1, width: 1, height: 1 }, 2, false));
    await idle(t.q);
    expect(t.store.tiles.size).toBe(256);
    push(t.q, t.store, [[0, 256 * 13 + 120], [W - 1, 256 * 15 + 30], [0, 256 * 15 + 200]], 127);
    await idle(t.q);
    expect(t.store.tiles.size).toBeGreaterThan(256 + 40 - 1);
    expect(t.p.maxMasks).toBeLessThanOrEqual(W / TILE_SIZE * (H / TILE_SIZE));
    for (const v of t.store.tiles.values()) expect(v.byteLength).toBeLessThanOrEqual(65536);
  });
});
