import { describe, expect, it } from "vitest";
import { paletteColour } from "../../../src/core/classes";
import type { Grid } from "../../../src/core/types";
import { importLabels, type SeedOutcome } from "../../../src/io/seeding";
import { fakeLabelSource } from "../helpers/labelFiles";
import { effectiveTiles } from "../helpers/effective";
import { fakeSource } from "../helpers/sources";

// Spec 004's import at the io level, now Replace only (spec 017): new labels are built beside the
// current ones, which change only when the caller swaps them in.

const GRID: Grid = { width: 512, height: 300, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
const imagery = () => fakeSource({ ...GRID, bandCount: 1 }, () => 1).source;
const file = (f: (c: number, r: number) => number = (c) => (c < 300 ? 3 : 7)) => fakeLabelSource(GRID, f).source;
const MAP = [{ value: 3, name: "B" }, { value: 7, name: "C" }];
/** The effective label at (c, r) (spec 014: stored tile, else the mask's), from effectiveTiles. */
const valueAt = (tiles: Map<string, Uint8Array>, c: number, r: number) => {
  const x0 = c - (c % 256), y0 = r - (r % 256), w = Math.min(256, GRID.width - x0);
  return tiles.get(`${x0},${y0}`)![(r - y0) * w + (c - x0)]!;
};
const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };

describe("too many", () => {
  it("gives \"too many\" past 255 classes", async () => {
    const f = fakeLabelSource(GRID, (c) => c % 256).source; // 256 distinct values, no nodata
    expect(await importLabels(imagery(), f, null)).toBe("too many");
  });
});

describe("Replace", () => {
  it("the list is the incoming one, and the mask is the base with no stored tile", async () => {
    const r = ok(await importLabels(imagery(), file(), MAP));
    expect(r.classes).toEqual([{ name: "B", colour: paletteColour(0) }, { name: "C", colour: paletteColour(1) }]);
    expect(r.pixels).toBe(512 * 300);
    const tiles = await effectiveTiles(imagery(), r);
    expect([valueAt(tiles, 0, 0), valueAt(tiles, 299, 5), valueAt(tiles, 300, 5)]).toEqual([1, 1, 2]);
    expect(r.store.tiles.size).toBe(0);
  });
});
