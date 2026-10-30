import { describe, expect, it, vi } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { decodedBytes, MAX_READ_BYTES, type Block } from "../../../src/core/imagery";
import { emptyStore } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { footprint } from "../../../src/core/pixel";
import type { Grid } from "../../../src/core/types";
import { bandOrder, MaskStore, type ValidMask } from "../../../src/core/validMask";
import { openLabelTiff } from "../../../src/io/labelFile";
import { MaskCache, STROKE, HOVER } from "../../../src/io/maskCache";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import { importLabels } from "../../../src/io/seeding";
import type { ImagerySource, RasterMeta } from "../../../src/io/source";
import { classFile, fakeLabelSource } from "../helpers/labelFiles";
import { idle } from "../helpers/paintQueue";
import { samplesSource, type SampleRead } from "../helpers/sources";

// Spec 023 criteria 3 (reads), 4 (bands requested, masks), 6 (background order) and 7 (copy-on-touch, label rows).

const W = 2000, H = 1500; // 6 bands of 256 rows
const GRID: Grid = { width: W, height: H, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
/** RGBA: transparent where c < 300 or in a block; band 0 is 9 at the nodata block. */
const transparent = (c: number, r: number) => c < 300 || (c >= 1000 && c < 1100 && r >= 700 && r < 800);
const value = (k: number, c: number, r: number) => (k === 3 ? (transparent(c, r) ? 0 : 255) : k === 0 && c >= 1500 && c < 1520 && r < 40 ? 9 : 100 + ((c + r) % 50));
const strips = (bytes = W * 4): Block => ({ width: W, height: 1, bytes });
const rgba = (meta: Partial<RasterMeta> = {}, block = strips()) => samplesSource({ ...GRID, bandCount: 4, alpha: 3, nodata: null, float: false, ...meta }, value, block);

const queueOf = (source: ImagerySource, cache = new MaskCache(source)) => {
  const store = emptyStore(W, H);
  const q = new PaintQueue(source, () => store, { applied() {}, full() {}, busy() {}, error: (e) => { throw e; } }, undefined, () => null, cache);
  return { q, store, cache };
};
const strokeOver = async (q: PaintQueue, side = 127, value = 1) => {
  for (let c = 100; c < 1900; c += 40) q.push(cellOp(footprint(GRID, c, 300 + (c % 600), side)!, value, false));
  await idle(q);
};
/** Rows read, failing if any row is read twice. */
const rowsOnce = (reads: SampleRead[]) => {
  const rows = new Set<number>();
  for (const r of reads) for (let y = r.y0; y < r.y0 + r.height; y++) { expect(rows.has(y), `row ${y}`).toBe(false); rows.add(y); }
  return rows;
};

describe("reads (criterion 3)", () => {
  for (const bytes of [W * 4, 200_000]) {
    it(`reads each band at most once, within MAX_READ_BYTES, and a second stroke reads nothing (strip bytes ${bytes})`, async () => {
      const { source, reads } = rgba({}, strips(bytes));
      const { q } = queueOf(source);
      await strokeOver(q);
      expect(reads.length).toBeGreaterThan(0);
      rowsOnce(reads);
      for (const r of reads) {
        expect([r.x0, r.width]).toEqual([0, W]);
        expect(decodedBytes(r, strips(bytes), W, H)).toBeLessThanOrEqual(MAX_READ_BYTES);
      }
      const n = reads.length;
      await strokeOver(q, 63, 2);
      expect(reads).toHaveLength(n);
    });
  }
});

/** A ValidMask as nodataMask bits of n pixels. */
const bitsOf = (m: ValidMask, n: number) => (typeof m !== "string" ? m : new Uint8Array(Math.ceil(n / 8)).fill(m === "all" ? 0 : 255));

describe("bands requested and masks (criterion 4)", () => {
  it("no nodata, integer samples and no alpha: no read, every window \"all\"", async () => {
    const { source, reads } = samplesSource({ ...GRID, bandCount: 3, alpha: null, nodata: null, float: false }, value, strips());
    const cache = new MaskCache(source);
    await cache.need(600, STROKE);
    expect(reads).toEqual([]);
    expect(cache.get("0,512")).toBe("all");
    expect(cache.get("1792,512")).toBe("all");
  });

  for (const [name, meta, want] of [
    ["alpha only", {}, "3"],
    ["alpha and nodata", { nodata: 9 }, "0,1,2,3"],
    ["alpha and float samples", { float: true }, "0,1,2,3"],
  ] as const) {
    it(`${name}: reads [${want}], and masks equal nodataMask with rule A`, async () => {
      const { source, reads } = samplesSource({ ...GRID, bandCount: 4, alpha: 3, nodata: null, float: false, ...meta }, value, strips(), true);
      const cache = new MaskCache(source);
      for (let y0 = 0; y0 < H; y0 += 256) await cache.need(y0, STROKE);
      expect(reads.every((r) => r.bands.join() === want)).toBe(true);
      const kinds = new Set<string>();
      for (let y0 = 0; y0 < H; y0 += 256) for (let x0 = 0; x0 < W; x0 += 256) {
        const w = Math.min(256, W - x0), h = Math.min(256, H - y0);
        const m = cache.get(`${x0},${y0}`)!;
        kinds.add(typeof m === "string" ? m : "bits");
        const want = nodataMask(await source.readWindow(x0, y0, w, h));
        expect(Buffer.from(bitsOf(m, w * h)).equals(Buffer.from(want)), `${x0},${y0}`).toBe(true);
      }
      expect(kinds).toEqual(new Set(["none", "all", "bits"]));
    });
  }
});

/** A source whose sample reads wait for release(), logging each band read in order. */
function held() {
  const { source: inner, reads } = rgba();
  const waiting: (() => void)[] = [];
  const source: ImagerySource = { ...inner, readSamples: (...a) => new Promise((r) => waiting.push(() => r(inner.readSamples(...a)))) };
  const release = async () => { while (!waiting.length) await new Promise((r) => setTimeout(r, 1)); waiting.shift()!(); await new Promise((r) => setTimeout(r, 5)); };
  return { source, reads, release, waiting };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const bandsRead = (reads: SampleRead[]) => reads.map((r) => r.y0 / 256);

describe("background reads (criterion 6)", () => {
  it("wait while the loader is busy, then run one at a time in bandOrder from the centre band", async () => {
    const { source, reads } = rgba();
    let busy = true;
    const cache = new MaskCache(source, { loaderBusy: () => busy, retryMs: 2 });
    cache.start(700); // band 2
    await tick(20);
    expect(reads).toEqual([]);
    busy = false;
    while (!cache.finished) await tick();
    expect(bandsRead(reads)).toEqual(bandOrder(6, 2));
    expect(cache.masks.size).toBe(6 * 8);
  });

  it("wait while the map moves (spec 027), while stroke reads still start", async () => {
    const { source, reads } = rgba();
    let moving = true;
    const cache = new MaskCache(source, { moving: () => moving, retryMs: 2 });
    cache.start(0);
    await tick(20);
    expect(reads).toEqual([]);
    await cache.need(3 * 256, STROKE);
    expect(bandsRead(reads)).toEqual([3]);
    await tick(20);
    expect(bandsRead(reads)).toEqual([3]);
    moving = false;
    while (!cache.finished) await tick();
    expect(bandsRead(reads)).toHaveLength(6);
  });

  it("pause during an import, and resume after", async () => {
    const { source, reads } = rgba();
    let importing = true;
    const cache = new MaskCache(source, { paused: () => importing, retryMs: 2 });
    cache.start(0);
    await tick(20);
    expect(reads).toEqual([]);
    importing = false;
    while (!cache.finished) await tick();
    expect(bandsRead(reads)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a stroke's or hover's band jumps ahead of queued background bands, the stroke's first", async () => {
    const h = held();
    const cache = new MaskCache(h.source);
    cache.start(0);
    await tick();
    expect(h.waiting).toHaveLength(1); // band 0 in flight
    const order: string[] = [];
    void cache.need(5 * 256, HOVER).then(() => order.push("hover 5"));
    void cache.need(4 * 256, STROKE).then(() => order.push("stroke 4"));
    for (let i = 0; i < 6; i++) await h.release();
    expect(bandsRead(h.reads)).toEqual([0, 4, 5, 1, 2, 3]);
    expect(order).toEqual(["stroke 4", "hover 5"]);
  });

  it("a hover's bands wait for start (\"Raster opened.\"); a stroke's do not (review 3)", async () => {
    const { source, reads } = rgba();
    const cache = new MaskCache(source);
    let hovered = false;
    void cache.need(3 * 256, HOVER).then(() => { hovered = true; });
    await tick(20);
    expect(reads).toEqual([]);
    await cache.need(1 * 256, STROKE);
    expect(bandsRead(reads)).toEqual([1]);
    cache.start(0);
    while (!hovered) await tick();
    expect(bandsRead(reads).slice(0, 2)).toEqual([1, 3]);
  });

  it("stop (another raster opened) ends the reads: no later band, waiting needs reject, the read in flight is dropped", async () => {
    const h = held();
    const cache = new MaskCache(h.source);
    cache.start(0);
    await tick();
    const need = cache.need(3 * 256, STROKE);
    cache.stop();
    await expect(need).rejects.toMatchObject({ name: "AbortError" });
    await h.release();
    await tick(20);
    expect(h.reads).toHaveLength(1);
    expect(cache.masks.size).toBe(0);
    await expect(cache.need(0, STROKE)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("after they finish, a stroke anywhere reads no imagery", async () => {
    const { source, reads } = rgba();
    const cache = new MaskCache(source);
    cache.start(H / 2);
    while (!cache.finished) await tick();
    const n = reads.length;
    const { q } = queueOf(source, cache);
    await strokeOver(q);
    for (let c = 0; c < W; c += 333) q.push(cellOp(footprint(GRID, c, H - 1 - c / 2, 31)!, 2, false));
    await idle(q);
    expect(reads).toHaveLength(n);
  });
});

describe("copy-on-touch and label rows (criterion 7)", () => {
  it("with a base, copy-on-touch on a cached window reads no imagery, and holds the masked base labels", async () => {
    const { source, reads } = rgba();
    const file = fakeLabelSource(GRID, (c, r) => 1 + ((c >> 5) + (r >> 5)) % 2);
    const r = await importLabels(source, file.source, [{ value: 1, name: "a" }, { value: 2, name: "b" }]);
    if (typeof r === "string") throw new Error(r);
    const cache = new MaskCache(source);
    cache.start(0);
    while (!cache.finished) await tick();
    reads.length = 0;
    const store = r.store;
    const q = new PaintQueue(source, () => store, { applied() {}, full() {}, busy() {}, error: (e) => { throw e; } }, undefined, () => r.base, cache);
    for (const [c, rr, erase] of [[10, 10, true], [400, 10, false], [1050, 750, false]] as const) q.push(cellOp(footprint(GRID, c, rr, 5)!, 2, erase));
    await idle(q);
    expect(reads).toEqual([]);
    // tile 0,0 is all transparent, so its base tile is empty and the erase copies nothing
    expect([...store.tiles.keys()].sort()).toEqual(["1024,512", "256,0"]);
    const base = (c: number, rr: number) => 1 + ((c >> 5) + (rr >> 5)) % 2;
    const t = store.tiles.get("256,0")!;
    expect([t[10 * 256 + 44], t[10 * 256 + 24], t[10 * 256 + 144]]).toEqual([base(300, 10), 0, 2]); // copied; transparent c 280; painted c 400
    const u = store.tiles.get("1024,512")!;
    expect([u[238 * 256 + 26], u[238 * 256 + 126]]).toEqual([0, base(1150, 750)]); // the dab fell on the transparent block
  });

  it("windows in up to 4 rows already read cause no label-file read", async () => {
    const g: Grid = { width: 600, height: 1400, epsg: 32633, gt: [260000, 2000, 0, 5200000, 0, -2000] };
    const tiff = await fromArrayBuffer(classFile("255", g, (c, r) => (c + r) % 7));
    const img = await tiff.getImage(0);
    const spy = vi.spyOn(img, "readRasters");
    tiff.getImage = async () => img;
    const file = await openLabelTiff(tiff);
    spy.mockClear();
    const win = (x0: number, y0: number) => ({ x0, y0, width: Math.min(256, 600 - x0), height: Math.min(256, 1400 - y0) });
    for (const y0 of [0, 256, 512, 768]) for (const x0 of [0, 256, 512]) {
      const w = win(x0, y0), got = await file.read(w);
      let bad = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== (x0 + (i % w.width) + y0 + Math.floor(i / w.width)) % 7) bad++;
      expect([got.length, bad]).toEqual([w.width * w.height, 0]);
    }
    expect(spy).toHaveBeenCalledTimes(4);
    for (const y0 of [768, 0, 512, 256]) await file.read(win(256, y0));
    expect(spy).toHaveBeenCalledTimes(4);
    await file.read(win(0, 1024)); // a 5th row drops the least recently used (row 768)
    await file.read(win(0, 256));
    expect(spy).toHaveBeenCalledTimes(5);
    await file.read(win(0, 768));
    expect(spy).toHaveBeenCalledTimes(6);
  });
});

describe("an op's masks past MASK_BYTES (review 4)", () => {
  it("a later band's read evicting an earlier key's mask in the same op still brushes by both masks", async () => {
    const S = 512, grid: Grid = { ...GRID, width: S, height: S };
    const nd = (c: number, r: number) => (c + r) % 3 === 0; // every window mixed: an 8 KiB array each
    const { source } = samplesSource({ ...grid, bandCount: 1, alpha: null, nodata: 0, float: false }, (_k, c, r) => (nd(c, r) ? 0 : 5), { width: S, height: 1, bytes: S });
    const cache = new MaskCache(source, { maskBytes: 2 * 8192 }); // one band
    const store = emptyStore(S, S);
    const errors: unknown[] = [];
    const q = new PaintQueue(source, () => store, { applied() {}, full() {}, busy() {}, error: (e) => { errors.push(e); } }, undefined, () => null, cache);
    q.push(cellOp({ x0: 100, y0: 200, width: 20, height: 100 }, 1, false)); // rows 200-299: keys 0,0 and 0,256
    await idle(q);
    expect(errors).toEqual([]);
    expect(cache.masks.has("0,0")).toBe(false); // evicted by band 1's read
    for (let r = 200; r < 300; r++) for (let c = 100; c < 120; c++) {
      const t = store.tiles.get(`0,${r < 256 ? 0 : 256}`)!;
      expect(t[(r % 256) * 256 + c], `${c},${r}`).toBe(nd(c, r) ? 0 : 1);
    }
  });

  it("a mask evicted again after every read gives up after 2 reads with an error, not a loop", async () => {
    const S = 256;
    const { source } = samplesSource({ ...GRID, width: S, height: S, bandCount: 1, alpha: null, nodata: 0, float: false }, () => 5, { width: S, height: 1, bytes: S });
    let needs = 0;
    const cache = { masks: new MaskStore(), get: () => undefined, need: async () => { needs++; } } as unknown as MaskCache;
    const store = emptyStore(S, S);
    const errors: unknown[] = [];
    const q = new PaintQueue(source, () => store, { applied() {}, full() {}, busy() {}, error: (e) => { errors.push(e); } }, undefined, () => null, cache);
    q.push(cellOp({ x0: 10, y0: 10, width: 5, height: 5 }, 1, false));
    await idle(q);
    expect(needs).toBe(2);
    expect(errors).toHaveLength(1);
    expect(store.tiles.size).toBe(0);
  });
});

