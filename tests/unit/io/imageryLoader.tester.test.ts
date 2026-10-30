import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import { MAX_READ_BYTES, type Level } from "../../../src/core/imagery";
import type { Grid } from "../../../src/core/types";
import { ImageryLoader } from "../../../src/io/imageryLoader";
import type { ImagerySource } from "../../../src/io/source";
import { fakeSource } from "../helpers/sources";

// Spec 020, tester: band counts, raster edges, nodata, read failures and the in-flight bound of the loader.
type Read = { image: number; win: Window; bands: number[]; signal?: AbortSignal; settle: (fail?: unknown) => void; settled: boolean };

/** A source of W x H whose sample reads wait for settle(); band k of (c, r) is value(k, c, r), raw as `Arr`. */
function held(W: number, H: number, bandCount: number, value: (k: number, c: number, r: number) => number,
  opts: { Arr?: Float32ArrayConstructor | Uint8ArrayConstructor; nodata?: number | null; block?: [number, number] } = {}) {
  const grid: Grid = { width: W, height: H, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
  const { source: inner } = fakeSource({ width: W, height: H, gt: grid.gt, bandCount, nodata: opts.nodata ?? null }, value);
  const reads: Read[] = [];
  const Arr = opts.Arr ?? Uint8Array;
  const [bw, bh] = opts.block ?? [256, 256];
  const source: ImagerySource = {
    ...inner,
    block: { width: bw, height: bh, bytes: bw * bh * bandCount * Arr.BYTES_PER_ELEMENT, sampleBytes: Arr.BYTES_PER_ELEMENT },
    overviews: [],
    readSamples(image, x0, y0, w, h, bands, signal) {
      return new Promise((resolve, reject) => {
        const r: Read = { image, win: { x0, y0, width: w, height: h }, bands, signal, settled: false, settle: (fail) => {
          if (r.settled) return;
          r.settled = true;
          if (fail !== undefined) { reject(fail); return; }
          if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
          resolve(bands.map((k) => { const a = new Arr(w * h); for (let p = 0; p < w * h; p++) a[p] = value(k, x0 + (p % w), y0 + Math.floor(p / w)); return a; }));
        } };
        reads.push(r);
      });
    },
  };
  return { source, reads, grid };
}

function sink() {
  const drawn = new Map<string, Uint8ClampedArray>();
  return { drawn, use: (k: string) => drawn.has(k), draw: (k: string, _l: Level, _t: Window, rgba: Uint8ClampedArray) => { drawn.set(k, rgba.slice()); } };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const R3: [number, number][] = [[0, 255], [0, 255], [0, 255]];

describe("ImageryLoader, tester", () => {
  it.each([[1, [0]], [2, [0]], [3, [0, 1, 2]], [4, [0, 1, 2]]])("a %i-band source reads bands %j", (nb, want) => {
    const { source, reads, grid } = held(512, 512, nb, () => 1);
    new ImageryLoader(source, R3, sink()).show({ level: { s: 1, grid, overview: null }, tiles: [{ x0: 0, y0: 0, width: 256, height: 256 }] });
    expect(reads[0]!.bands).toEqual(want);
  });

  it("clips an s = 4 read at the right and bottom edges, and the edge texels sample the last pixels", async () => {
    // 1030 x 1029: level 258 x 258, edge tile at x0 = 256 is 2 texels wide
    const v = (k: number, c: number, r: number) => (c * 7 + r * 3 + k) % 256;
    const { source, reads } = held(1030, 1029, 3, v);
    const s = sink();
    const level: Level = { s: 4, overview: null, grid: { width: 258, height: 258, epsg: 32633, gt: [500000, 120, 0, 5000000, 0, -120] } };
    new ImageryLoader(source, R3, s).show({ level, tiles: [{ x0: 256, y0: 256, width: 2, height: 2 }] });
    expect(reads[0]!.win).toEqual({ x0: 1024, y0: 1024, width: 6, height: 5 });
    reads[0]!.settle();
    await flush();
    const rgba = s.drawn.get("4-256,256")!;
    // texel (257, 257) samples min(257*4+2, last) = (1029, 1028)
    expect(rgba[4 * 3]).toBe(v(0, 1029, 1028));
    expect(rgba[4 * 0 + 1]).toBe(v(1, 1026, 1026));
  });

  it("draws nodata and NaN pixels transparent", async () => {
    const v = (_k: number, c: number) => (c === 3 ? -9 : c === 4 ? NaN : 10);
    const { source, reads, grid } = held(256, 256, 1, v, { Arr: Float32Array, nodata: -9 });
    const s = sink();
    new ImageryLoader(source, [[0, 20]], s).show({ level: { s: 1, grid, overview: null }, tiles: [{ x0: 0, y0: 0, width: 256, height: 256 }] });
    reads[0]!.settle();
    await flush();
    const rgba = s.drawn.get("1-0,0")!;
    expect([rgba[4 * 2 + 3], rgba[4 * 3 + 3], rgba[4 * 4 + 3], rgba[4 * 5 + 3]]).toEqual([255, 0, 0, 255]);
  });

  it("a read that fails (not an abort) draws nothing, frees its slot, and the tile is asked for again on the next view", async () => {
    const { source, reads, grid } = held(2048, 256, 3, () => 1);
    const s = sink();
    const loader = new ImageryLoader(source, R3, s);
    const level: Level = { s: 1, grid, overview: null };
    const t = (x0: number): Window => ({ x0, y0: 0, width: 256, height: 256 });
    // two separate rows' worth: tiles with gaps so each is its own read
    loader.show({ level, tiles: [t(0), t(512), t(1024)] });
    expect(reads).toHaveLength(2);
    reads[0]!.settle(new Error("NotReadableError"));
    await flush();
    expect(s.drawn.size).toBe(0);
    expect(reads).toHaveLength(3); // the third read started in the freed slot
    loader.show({ level, tiles: [t(0)] });
    for (const r of [...reads]) r.settle(); // the aborted reads hold their slots until they settle
    await flush();
    expect(reads.filter((r) => r.win.x0 === 0)).toHaveLength(2);
    reads.at(-1)!.settle();
    await flush();
    expect([...s.drawn.keys()]).toEqual(["1-0,0"]);
  });

  it("never has more than two sample reads unsettled, however often the view changes (memory: 2 x MAX_READ_BYTES in flight)", async () => {
    const { source, reads, grid } = held(8192, 8192, 3, () => 1);
    const loader = new ImageryLoader(source, R3, sink());
    const level: Level = { s: 1, grid, overview: null };
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      const x0 = (i * 768) % 7936, y0 = ((i * 5) % 31) * 256;
      loader.show({ level, tiles: [{ x0, y0, width: 256, height: 256 }, { x0, y0: (y0 + 512) % 7936, width: 256, height: 256 }, { x0, y0: (y0 + 1024) % 7936, width: 256, height: 256 }] });
      peak = Math.max(peak, reads.filter((r) => !r.settled).length);
      if (i % 3 === 0) { reads.find((r) => !r.settled)?.settle(); await flush(); }
    }
    expect(peak).toBeLessThanOrEqual(2);
    for (const r of reads) {
      expect(r.win.width * r.win.height * r.bands.length * source.block.sampleBytes).toBeLessThanOrEqual(MAX_READ_BYTES);
    }
  });

  it("changing level aborts the old level's reads and draws only the new level's tiles", async () => {
    const { source, reads, grid } = held(4096, 4096, 3, () => 50);
    const s = sink();
    const loader = new ImageryLoader(source, R3, s);
    loader.show({ level: { s: 1, grid, overview: null }, tiles: [{ x0: 0, y0: 0, width: 256, height: 256 }] });
    const dec: Level = { s: 2, overview: null, grid: { ...grid, width: 2048, height: 2048, gt: [500000, 60, 0, 5000000, 0, -60] } };
    loader.show({ level: dec, tiles: [{ x0: 0, y0: 0, width: 256, height: 256 }] });
    expect(reads[0]!.signal!.aborted).toBe(true);
    for (const r of [...reads]) r.settle();
    await flush();
    for (const r of [...reads]) r.settle();
    await flush();
    expect([...s.drawn.keys()]).toEqual(["2-0,0"]);
  });

  // ADR 0020 / spec 020 memory: "at most 2 x 32 MiB of reads in flight". geotiff.js decodes every block a window touches,
  // all at once (Promise.all in GeoTIFFImage._readRaster), so for a striped file a read decodes full-width strips.
  it("on a 22,300 px wide file of 1-row strips, the blocks one s = 4 read decodes stay within MAX_READ_BYTES (was B2)", () => {
    const W = 22300, H = 22300;
    const { source, reads, grid } = held(W, H, 3, () => 1, { block: [W, 1] });
    const loader = new ImageryLoader(source, R3, sink());
    const level: Level = { s: 4, overview: null, grid: { ...grid, width: Math.ceil(W / 4), height: Math.ceil(H / 4), gt: [500000, 120, 0, 5000000, 0, -120] } };
    loader.show({ level, tiles: [{ x0: 2560, y0: 2560, width: 256, height: 256 }] });
    const decoded = (w: Window) => {
      const { width: bw, height: bh, bytes } = source.block;
      const bx = Math.ceil((w.x0 + w.width) / bw) - Math.floor(w.x0 / bw), by = Math.ceil((w.y0 + w.height) / bh) - Math.floor(w.y0 / bh);
      return bx * by * bytes;
    };
    for (const r of reads) expect(decoded(r.win)).toBeLessThanOrEqual(MAX_READ_BYTES); // 22300 x 1024 x 3 B = 68.5 MB
  });
});
