import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import type { Level } from "../../../src/core/imagery";
import type { Grid } from "../../../src/core/types";
import { ImageryLoader, tileKey } from "../../../src/io/imageryLoader";
import type { ImagerySource } from "../../../src/io/source";
import { fakeSource } from "../helpers/sources";

// Spec 020 criterion 8: panning away aborts queued reads, and an aborted read draws nothing.
const W = 4096, H = 1024;
const GRID: Grid = { width: W, height: H, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
const value = (k: number, c: number, r: number) => (k * 7 + c + r) % 200;

type Pending = { image: number; win: Window; signal: AbortSignal | undefined; resolve: () => void; fail: (e: unknown) => void };

/** A source whose sample reads wait until released; band k of pixel (c, r) is value(k, c, r). */
function heldSource(block = { width: 256, height: 256, bytes: 256 * 256 * 3 }) {
  const { source: inner } = fakeSource({ width: W, height: H, gt: GRID.gt }, value);
  const pending: Pending[] = [];
  const source: ImagerySource = {
    ...inner,
    block,
    overviews: [],
    readSamples(image, x0, y0, w, h, bands, signal) {
      return new Promise((resolve, reject) => {
        const win = { x0, y0, width: w, height: h };
        pending.push({ image, win, signal, fail: reject, resolve: () => {
          if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
          resolve(bands.map((k) => Uint8Array.from({ length: w * h }, (_, p) => value(k, x0 + (p % w), y0 + Math.floor(p / w)))));
        } });
      });
    },
  };
  return { source, pending };
}

function sink() {
  const drawn = new Map<string, Uint8ClampedArray>();
  return { drawn, use: (key: string) => drawn.has(key), draw: (key: string, _l: Level, _t: Window, rgba: Uint8ClampedArray) => { drawn.set(key, rgba.slice()); } };
}

const LEVEL: Level = { s: 1, grid: GRID, overview: null };
const row = (y0: number, xs: number[]): Window[] => xs.map((x0) => ({ x0, y0, width: 256, height: 256 }));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ImageryLoader (criterion 8)", () => {
  it("reads each row of visible tiles as one window, two at a time, and draws them through the preview stretch", async () => {
    const { source, pending } = heldSource();
    const s = sink();
    const loader = new ImageryLoader(source, [[0, 200], [0, 200], [0, 200]], s);
    loader.show({ level: LEVEL, tiles: [...row(256, [512, 768]), ...row(0, [512, 768]), ...row(512, [0])] });
    expect(pending.map((p) => p.win)).toEqual([{ x0: 512, y0: 256, width: 512, height: 256 }, { x0: 512, y0: 0, width: 512, height: 256 }]);
    pending[0]!.resolve();
    await flush();
    expect([...s.drawn.keys()].sort()).toEqual([tileKey(LEVEL, row(256, [512])[0]!), tileKey(LEVEL, row(256, [768])[0]!)].sort());
    expect(pending).toHaveLength(3);
    const rgba = s.drawn.get("1-768,256")!;
    const p = 10 * 256 + 3; // tile pixel (3, 10) is raster pixel (771, 266)
    expect([rgba[4 * p], rgba[4 * p + 1], rgba[4 * p + 3]]).toEqual([Math.round((value(0, 771, 266) / 200) * 255), Math.round((value(1, 771, 266) / 200) * 255), 255]);
  });

  it("aborts reads no longer visible, never starts queued ones, and draws nothing from an aborted read", async () => {
    const { source, pending } = heldSource();
    const s = sink();
    const loader = new ImageryLoader(source, [[0, 200], [0, 200], [0, 200]], s);
    loader.show({ level: LEVEL, tiles: [...row(0, [0]), ...row(256, [0]), ...row(512, [0]), ...row(768, [0])] });
    expect(pending).toHaveLength(2);
    // pan away: only the second row's tile, and a new one, stay visible
    loader.show({ level: LEVEL, tiles: [...row(256, [0]), ...row(0, [3072])] });
    expect(pending[0]!.signal!.aborted).toBe(true);
    expect(pending[1]!.signal!.aborted).toBe(false);
    expect(pending).toHaveLength(2); // the aborted read holds its slot until it settles
    pending[0]!.resolve();
    await flush();
    expect(pending.map((p) => p.win.y0)).toEqual([0, 256, 0]);
    expect(pending[2]!.win.x0).toBe(3072);
    for (const p of pending) p.resolve();
    await flush();
    expect([...s.drawn.keys()].sort()).toEqual(["1-0,256", "1-3072,0"]);
    expect(pending).toHaveLength(3); // rows 512 and 768 were never read
  });

  it("samples full resolution at i*s + floor(s/2) when the level has no overview, and reads an overview directly", async () => {
    const { source, pending } = heldSource();
    const s = sink();
    const loader = new ImageryLoader(source, [[0, 255], [0, 255], [0, 255]], s);
    const dec: Level = { s: 4, overview: null, grid: { ...GRID, width: W / 4, height: H / 4, gt: [500000, 120, 0, 5000000, 0, -120] } };
    loader.show({ level: dec, tiles: row(0, [768]) });
    expect(pending[0]).toMatchObject({ image: 0, win: { x0: 3072, y0: 0, width: 1024, height: 1024 } });
    pending[0]!.resolve();
    await flush();
    const rgba = s.drawn.get("4-768,0")!;
    const p = 5 * 256 + 7; // texel (775, 5) samples raster pixel (3102, 22)
    expect(rgba[4 * p + 2]).toBe(value(2, 775 * 4 + 2, 5 * 4 + 2));
    const ov: Level = { ...dec, overview: 3 };
    loader.show({ level: ov, tiles: row(0, [0]) });
    expect(pending[1]).toMatchObject({ image: 3, win: { x0: 0, y0: 0, width: 256, height: 256 } });
  });

  it("skips tiles already drawn, and stop() aborts everything", () => {
    const { source, pending } = heldSource();
    const s = sink();
    s.drawn.set("1-0,0", new Uint8ClampedArray(0));
    const loader = new ImageryLoader(source, [[0, 1], [0, 1], [0, 1]], s);
    loader.show({ level: LEVEL, tiles: row(0, [0, 256]) });
    expect(pending.map((p) => p.win)).toEqual([{ x0: 256, y0: 0, width: 256, height: 256 }]);
    loader.stop();
    expect(pending[0]!.signal!.aborted).toBe(true);
    loader.show(null);
    expect(pending).toHaveLength(1);
  });

  it("fills a tile from several block-bounded reads and draws it once the last one lands (A1)", async () => {
    // 1-row strips of 98,304 B: a 1024-row read would decode 96 MiB, so it splits into reads of 170 rows
    const { source, pending } = heldSource({ width: W, height: 1, bytes: 98304 });
    const s = sink();
    const loader = new ImageryLoader(source, [[0, 255], [0, 255], [0, 255]], s);
    const dec: Level = { s: 4, overview: null, grid: { ...GRID, width: W / 4, height: H / 4, gt: [500000, 120, 0, 5000000, 0, -120] } };
    loader.show({ level: dec, tiles: row(0, [768]) });
    for (let k = 0; k < 7; k++) {
      expect(s.drawn.size).toBe(0);
      pending[k]!.resolve();
      await flush();
    }
    expect(pending.map((p) => p.win.height)).toEqual([170, 170, 170, 170, 170, 170, 4]);
    expect(pending.every((p) => p.win.x0 === 3072 && p.win.width === 1024)).toBe(true);
    const rgba = s.drawn.get("4-768,0")!;
    for (const [i, j] of [[7, 5], [100, 42], [255, 255]]) expect(rgba[4 * (j! * 256 + i!) + 2]).toBe(value(2, (768 + i!) * 4 + 2, j! * 4 + 2));
  });

  it("draws nothing for a tile whose reads were cut short, and reads it again on a later view", async () => {
    const { source, pending } = heldSource({ width: W, height: 1, bytes: 98304 });
    const s = sink();
    const loader = new ImageryLoader(source, [[0, 255], [0, 255], [0, 255]], s);
    const dec: Level = { s: 4, overview: null, grid: { ...GRID, width: W / 4, height: H / 4, gt: [500000, 120, 0, 5000000, 0, -120] } };
    loader.show({ level: dec, tiles: row(0, [768]) });
    pending[0]!.resolve();
    await flush();
    loader.show({ level: dec, tiles: row(0, [0]) }); // panned away mid-tile
    for (let i = 0; i < 10; i++) { for (const p of [...pending]) p.resolve(); await flush(); } // every read settles
    expect([...s.drawn.keys()]).toEqual(["4-0,0"]);
    const before = pending.length;
    loader.show({ level: dec, tiles: row(0, [768]) });
    expect(pending.length).toBeGreaterThan(before);
    expect(pending[before]!.win).toEqual({ x0: 3072, y0: 0, width: 1024, height: 170 });
  });
});

describe("read failures (criterion 10)", () => {
  it("reports an Error or a ProgressEvent, not an abort, and asks for the tile again later", async () => {
    const { source, pending } = heldSource();
    const errors: unknown[] = [];
    const s = sink();
    const loader = new ImageryLoader(source, [[0, 1], [0, 1], [0, 1]], s, (e) => errors.push(e));
    const PE = typeof ProgressEvent === "undefined" ? Event : ProgressEvent;
    loader.show({ level: LEVEL, tiles: [...row(0, [0]), ...row(256, [0])] });
    pending[0]!.fail(new Error("NotReadableError"));
    pending[1]!.fail(new PE("error"));
    await flush();
    expect(errors).toHaveLength(2);
    loader.show({ level: LEVEL, tiles: row(512, [0]) }); // aborts nothing running; nothing reported
    loader.show({ level: LEVEL, tiles: row(768, [0]) });
    expect(pending[2]!.signal!.aborted).toBe(true);
    pending[2]!.resolve();
    await flush();
    expect(errors).toHaveLength(2);
    loader.show({ level: LEVEL, tiles: row(0, [0]) });
    expect(pending.at(-1)!.win).toEqual({ x0: 0, y0: 0, width: 256, height: 256 });
  });

  it("a draw that throws (e.g. after a WebGL context loss) reports the error and leaves the job's tiles to be asked for again", async () => {
    const { source, pending } = heldSource();
    const errors: unknown[] = [];
    let fail = true;
    const drawn: string[] = [];
    const sink = { use: (k: string) => drawn.includes(k), draw: (k: string) => { if (fail) throw new Error("addSource"); drawn.push(k); } };
    const loader = new ImageryLoader(source, [[0, 1], [0, 1], [0, 1]], sink, (e) => errors.push(e));
    loader.show({ level: LEVEL, tiles: row(0, [0, 256]) }); // one read, two tiles
    expect(pending).toHaveLength(1);
    pending[0]!.resolve();
    await flush();
    expect(errors).toEqual([new Error("addSource")]);
    fail = false;
    loader.show({ level: LEVEL, tiles: row(0, [0, 256]) });
    expect(pending).toHaveLength(2);
    expect(pending[1]!.win).toEqual({ x0: 0, y0: 0, width: 512, height: 256 });
    pending[1]!.resolve();
    await flush();
    expect(drawn.sort()).toEqual(["1-0,0", "1-256,0"]);
  });
});
