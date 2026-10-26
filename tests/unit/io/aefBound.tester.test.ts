import { afterEach, describe, expect, it, vi } from "vitest";
import { BAND_GROUP } from "../../../src/io/aefDownload";
import { colsAcross, eachByteOnce, pixelsRight, run, type Spec } from "../helpers/aefPassProbe";

// Tester re-verification of the per-COG bound on held compressed tiles and decoded tiles per read
// (spec 002 Cache, review issue 1), checked structurally through the public RangeSource calls.
afterEach(() => vi.restoreAllMocks());

describe("memory bound per COG (tester, structural)", () => {
  /** Held compressed tiles per COG: group x (C + ceil(256 / t) x (ceil(256 / t) + 1)); group x (C + 2) from 256 px. */
  const heldBound = (s: Spec, ax: number, w: number) =>
    BAND_GROUP * (colsAcross(s, ax, w) + (s.tile >= 256 ? 2 : Math.ceil(256 / s.tile) * (Math.ceil(256 / s.tile) + 1)));
  /** Decoded tiles under one 256 px window read: group x (tiles a 256 px span can touch)^2. */
  const decodedBound = (s: Spec) => BAND_GROUP * (Math.ceil(255 / s.tile) + 1) ** 2;

  const cases: [string, Spec[], [number, number, number, number]][] = [
    // real AEF layout (band-separate, tiles of 256 px or more) at half scale: 512 px tiles, AOI windows
    // straddling the tile edge at global 512 in both axes, as 1024 px tiles at 1024 would
    ["512 px tiles, windows straddling the tile corner", [{ name: "big", gx0: 0, gy0: 0, width: 1024, height: 1024, tile: 512, bottomUp: true }], [450, 450, 300, 300]],
    // four COGs meeting at one corner inside a window, one 512 px tile per band each
    ["four 512 px-tile COGs meeting at a corner inside a window", [
      { name: "nw", gx0: 0, gy0: 0, width: 512, height: 512, tile: 512, bottomUp: true },
      { name: "ne", gx0: 512, gy0: 0, width: 500, height: 512, tile: 512 },
      { name: "sw", gx0: 0, gy0: 512, width: 512, height: 505, tile: 512 },
      { name: "se", gx0: 512, gy0: 512, width: 495, height: 500, tile: 512, bottomUp: true },
    ], [450, 450, 300, 300]],
    ["16 px tiles at an odd offset", [{ name: "t16", gx0: 0, gy0: 0, width: 400, height: 330, tile: 16, bottomUp: true }], [7, 9, 300, 300]],
    ["48 px tiles, AOI past the COG's edges", [{ name: "t48", gx0: 3, gy0: 5, width: 500, height: 520, tile: 48 }], [0, 0, 540, 530]],
    ["300 px tiles, four COGs at a corner", [
      { name: "a", gx0: 0, gy0: 0, width: 600, height: 600, tile: 300 },
      { name: "b", gx0: 600, gy0: 0, width: 610, height: 600, tile: 300, bottomUp: true },
      { name: "c", gx0: 0, gy0: 600, width: 600, height: 620, tile: 300, bottomUp: true },
      { name: "d", gx0: 600, gy0: 600, width: 630, height: 640, tile: 300 },
    ], [450, 470, 600, 560]],
  ];

  it.each(cases)("%s: held tiles and decoded tiles per read within the bound, nothing held at the end, no refetch", async (_n, specs, box) => {
    const r = await run(specs, box);
    expect(r.probe.held.size).toBe(specs.length);
    for (const [s, n] of r.probe.peak) {
      const c = r.cogOf(s);
      expect(n, `${c.s.name} peak held`).toBeLessThanOrEqual(heldBound(c.s, box[0], box[2]));
      expect(r.probe.held.get(s)!.size, `${c.s.name} held at the end`).toBe(0);
    }
    for (const read of r.probe.reads) {
      const c = r.cogOf(read.tiles[0]?.src ?? [...r.probe.held.keys()][0]!);
      const [c0, r0, c1, r1] = read.window as [number, number, number, number];
      expect(c1 - c0).toBeLessThanOrEqual(256); expect(r1 - r0).toBeLessThanOrEqual(256);
      expect(read.samples).toHaveLength(BAND_GROUP);
      expect(new Set(read.tiles.map((t) => t.src)).size).toBeLessThanOrEqual(1);
      expect(read.tiles.length, `${c.s.name} decoded tiles in one read`).toBeLessThanOrEqual(decodedBound(c.s));
      if (c.s.tile >= 256) expect(read.tiles.length).toBeLessThanOrEqual(BAND_GROUP * 4);
    }
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    await pixelsRight(r, box, 23);
  }, 120_000);
});
