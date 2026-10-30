import { describe, expect, it, vi } from "vitest";
import * as decimate from "../../../src/core/decimate";
import type { Window } from "../../../src/core/grid";
import type { Level } from "../../../src/core/imagery";
import type { Grid } from "../../../src/core/types";
import { ImageryLoader, tileKey } from "../../../src/io/imageryLoader";
import type { ImagerySource } from "../../../src/io/source";
import { samplesSource } from "../helpers/sources";

// Spec 028 criterion 3 (tester finding on criterion 4): the decimation after a read lands shares the 8 ms budget,
// so a read feeding many tiles is decimated across yields, not in one task.

vi.mock("../../../src/core/decimate", async (orig) => {
  const m = await orig<typeof import("../../../src/core/decimate")>();
  return { ...m, decimateInto: vi.fn(m.decimateInto) };
});

const GRID: Grid = { width: 8192, height: 4096, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
const LEVEL: Level = { s: 1, grid: GRID, overview: null };
const tiles: Window[] = [768, 512, 1024, 256, 1280, 0, 1536].map((x0) => ({ x0, y0: 0, width: 256, height: 256 }));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("decimation after a read lands (criterion 3)", () => {
  it("yields between tiles once 8 ms have passed, before decimating the rest of the read's tiles", async () => {
    let t = 0;
    const real = vi.mocked(decimate.decimateInto).getMockImplementation()!;
    vi.mocked(decimate.decimateInto).mockImplementation((...a) => { real(...a); t += 5; }); // each tile's decimation takes 5 ms
    const { source: inner } = samplesSource({ ...GRID, bandCount: 3, float: false }, (k, c, r) => (k + c + r) % 200, { width: 256, height: 256, bytes: 256 * 256 * 3 });
    const source: ImagerySource = { ...inner, raw: [0] }; // one read for the row of 7 tiles
    const yields: (() => void)[] = [];
    const drawn: string[] = [];
    const loader = new ImageryLoader(source, [[0, 200], [0, 200], [0, 200]], { use: (k) => drawn.includes(k), draw: (k) => { drawn.push(k); } },
      (e) => { throw e; }, { now: () => t, yieldTask: () => new Promise<void>((r) => yields.push(r)) });
    loader.show({ level: LEVEL, tiles });
    await flush();
    expect(decimate.decimateInto).toHaveBeenCalledTimes(2); // at 0 and 5 ms; at 10 ms it yields
    expect(yields).toHaveLength(1);
    expect(drawn).toEqual([]);
    yields.shift()!();
    await flush();
    expect(decimate.decimateInto).toHaveBeenCalledTimes(4);
    while (yields.length) { yields.shift()!(); await flush(); }
    expect(decimate.decimateInto).toHaveBeenCalledTimes(7);
    expect(drawn).toEqual(tiles.map((w) => tileKey(LEVEL, w))); // centre first
    expect(loader.busy()).toBe(false);
  });
});
