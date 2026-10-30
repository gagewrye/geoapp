import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import { decodedBytes, MAX_READ_BYTES, TASK_READ_BYTES, type Block, type Level } from "../../../src/core/imagery";
import type { Grid } from "../../../src/core/types";
import { DRAW_BUDGET_MS, ImageryLoader, tileKey } from "../../../src/io/imageryLoader";
import type { ImagerySource } from "../../../src/io/source";
import { samplesSource } from "../helpers/sources";

// Spec 028 criterion 3: draws yield after 8 ms (fake clock), a stale view's tiles aren't drawn, and reads through geotiff
// decode at most TASK_READ_BYTES.

const W = 8192, H = 4096;
const GRID: Grid = { width: W, height: H, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
const LEVEL: Level = { s: 1, grid: GRID, overview: null };
const value = (k: number, c: number, r: number) => (k + c + r) % 200;
const row = (y0: number, xs: number[]): Window[] => xs.map((x0) => ({ x0, y0, width: 256, height: 256 }));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A loader over a fake source and clock: each draw takes `drawMs`, and yields wait until released; read raw by default, so a row of tiles is one read. */
function rig(block: Block = { width: 256, height: 256, bytes: 256 * 256 * 3 }, raw: number[] = [0], drawMs = 3) {
  const { source: inner, reads } = samplesSource({ ...GRID, bandCount: 3, float: false }, value, block);
  const source: ImagerySource = { ...inner, raw };
  let t = 0;
  const yields: (() => void)[] = [];
  const drawn: string[] = [];
  const sink = { use: (k: string) => drawn.includes(k), draw: (k: string) => { t += drawMs; drawn.push(k); } };
  const loader = new ImageryLoader(source, [[0, 200], [0, 200], [0, 200]], sink, (e) => { throw e; },
    { now: () => t, yieldTask: () => new Promise<void>((r) => yields.push(r)) });
  const release = async () => { yields.shift()!(); await flush(); };
  return { loader, reads, drawn, yields, release };
}

describe("drawing (criterion 3)", () => {
  it("draws ready tiles centre first and yields once DRAW_BUDGET_MS of draws have passed in the task", async () => {
    expect(DRAW_BUDGET_MS).toBe(8);
    const { loader, drawn, yields, release } = rig();
    // one read of 7 tiles; the plan's centre is the middle tile
    const tiles = row(0, [768, 512, 1024, 256, 1280, 0, 1536]);
    loader.show({ level: LEVEL, tiles });
    await flush();
    expect(drawn).toEqual(tiles.slice(0, 3).map((t) => tileKey(LEVEL, t))); // at 0, 3 and 6 ms; at 9 ms it yields
    expect(yields).toHaveLength(1);
    expect(loader.busy()).toBe(true);
    await release();
    expect(drawn).toHaveLength(6);
    await release();
    expect(drawn).toEqual(tiles.map((t) => tileKey(LEVEL, t)));
    expect(yields).toHaveLength(0);
    expect(loader.busy()).toBe(false);
  });

  it("a tile whose view went stale while it waited isn't drawn, and is read again when a later view asks for it", async () => {
    const { loader, drawn, reads, release } = rig();
    const tiles = row(0, [768, 512, 1024, 256, 1280, 0, 1536]);
    loader.show({ level: LEVEL, tiles });
    await flush();
    expect(drawn).toHaveLength(3);
    loader.show({ level: LEVEL, tiles: [tiles[3]!, ...row(2048, [0])] }); // keeps one waiting tile, drops three
    await flush();
    await release();
    expect(drawn).toEqual([...tiles.slice(0, 4), row(2048, [0])[0]!].map((t) => tileKey(LEVEL, t)));
    expect(reads).toHaveLength(2); // the kept tile wasn't read again
    loader.show({ level: LEVEL, tiles: [tiles[4]!] });
    expect(reads.at(-1)).toMatchObject({ x0: 1280, y0: 0, width: 256, height: 256 });
  });

  it("stop() drops the tiles waiting to be drawn", async () => {
    const { loader, drawn, release } = rig();
    loader.show({ level: LEVEL, tiles: row(0, [0, 256, 512, 768, 1024]) });
    await flush();
    loader.stop();
    await release();
    expect(drawn).toHaveLength(3);
    expect(loader.busy()).toBe(false);
  });
});

describe("read size (criterion 3)", () => {
  // 1-row strips of a 8192 px wide RGB file: 24 KiB each
  const strips: Block = { width: W, height: 1, bytes: W * 3 };
  const tiles = row(1024, [0, 256, 512, 768, 1024, 1280, 1536, 1792]);

  it("reads through geotiff decode at most TASK_READ_BYTES each", async () => {
    const { loader, reads } = rig(strips, [], 0);
    loader.show({ level: { s: 2, grid: { ...GRID, width: W / 2, height: H / 2 }, overview: null }, tiles });
    for (let i = 0; i < 20; i++) await flush();
    expect(reads.length).toBeGreaterThan(1);
    for (const r of reads) expect(decodedBytes(r, strips, W, H)).toBeLessThanOrEqual(TASK_READ_BYTES);
    expect(new Set(reads.flatMap((r) => Array.from({ length: r.height }, (_, i) => r.y0 + i))).size).toBe(512);
  });

  it("raw reads keep spec 020's MAX_READ_BYTES", async () => {
    const { loader, reads } = rig(strips, [0], 0);
    loader.show({ level: { s: 2, grid: { ...GRID, width: W / 2, height: H / 2 }, overview: null }, tiles });
    await flush();
    expect(reads.map((r) => r.height)).toEqual([512]); // 12 MiB of strips, under MAX_READ_BYTES
    expect(decodedBytes(reads[0]!, strips, W, H)).toBeLessThanOrEqual(MAX_READ_BYTES);
  });
});
