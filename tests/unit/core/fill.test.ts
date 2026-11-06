import { describe, expect, it } from "vitest";
import { edgeSeeds, FILL_REACH, fillTile, inReach } from "../../../src/core/fill";

// Spec 054 criterion 2.
const T = { x0: 0, y0: 0, width: 5, height: 4 };
/** Rows of digits to a tile's labels. */
const tile = (...rows: string[]) => Uint8Array.from(rows.join(""), Number);
const filled = (bits: Uint8Array) => [...bits].map((b, i) => (b ? i : -1)).filter((i) => i >= 0);

describe("fillTile", () => {
  it("fills the 4-connected pixels of the seed's label, not ones touching only at a corner", () => {
    const labels = tile(
      "11200",
      "12100",
      "22111",
      "11111",
    );
    const bits = new Uint8Array(20);
    fillTile(labels, "all", T, 1, bits, [0]);
    expect(filled(bits)).toEqual([0, 1, 5]); // (2,1) touches (1,0) only diagonally
    const two = new Uint8Array(20);
    fillTile(labels, "all", T, 2, two, [6]);
    expect(filled(two)).toEqual([6, 10, 11]); // the 2 at (2,0) is diagonal to (1,1)
  });

  it("reports the edge pixels it filled: rows on the left and right, columns on the top and bottom", () => {
    const labels = tile(
      "00300",
      "33333",
      "00300",
      "00300",
    );
    const e = fillTile(labels, "all", T, 3, new Uint8Array(20), [7]);
    expect({ left: e.left, right: e.right, up: e.up, down: e.down }).toEqual({ left: [1], right: [1], up: [2], down: [2] });
  });

  it("with no labels every pixel is 0, and nodata pixels stop the fill", () => {
    // nodata down column 2: the fill from the left stays left of it
    const nodata = new Uint8Array(3);
    for (let i = 2; i < 20; i += 5) nodata[i >> 3]! |= 1 << (i & 7);
    const bits = new Uint8Array(20);
    fillTile(null, nodata, T, 0, bits, [0]);
    expect(filled(bits)).toEqual([0, 1, 5, 6, 10, 11, 15, 16]);
    expect(filled((() => { const b = new Uint8Array(20); fillTile(null, "none", T, 0, b, [0]); return b; })())).toEqual([]);
    expect(filled((() => { const b = new Uint8Array(20); fillTile(null, "all", T, 0, b, [0]); return b; })())).toHaveLength(20);
  });

  it("a later call keeps the earlier bits, fills only from new seeds, and reports only what it newly filled", () => {
    const labels = tile(
      "10101",
      "10101",
      "10101",
      "10101",
    );
    const bits = new Uint8Array(20);
    fillTile(labels, "all", T, 1, bits, [0]);
    const again = fillTile(labels, "all", T, 1, bits, [0, 4]);
    expect(filled(bits)).toEqual([0, 4, 5, 9, 10, 14, 15, 19]);
    expect(again.left).toEqual([]);
    expect([...again.right].sort()).toEqual([0, 1, 2, 3]);
    // a seed of another label, or a nodata one, fills nothing
    expect(fillTile(labels, "all", T, 1, new Uint8Array(20), [1]).up).toEqual([]);
  });

  it("FILL_REACH is 4 tiles", () => { expect(FILL_REACH).toBe(4); });
});

describe("edgeSeeds", () => {
  // a 600 x 520 raster: tiles are 256 wide except the last column (88) and row (8)
  const dims = { width: 600, height: 520 };
  const win = (x0: number, y0: number) => ({ x0, y0, width: Math.min(256, 600 - x0), height: Math.min(256, 520 - y0) });

  it("gives each neighbour the pixels facing the filled edge, in the neighbour's own width and height", () => {
    const got = edgeSeeds(dims, win(256, 256), { left: [3], right: [5], up: [7], down: [9] });
    expect(got).toEqual([
      { t: win(0, 256), seeds: [3 * 256 + 255] },
      { t: win(512, 256), seeds: [5 * 88] }, // the partial last column
      { t: win(256, 0), seeds: [255 * 256 + 7] },
      { t: win(256, 512), seeds: [9] }, // the partial last row
    ]);
    // into a partial tile from below: its last row is row 7
    expect(edgeSeeds(dims, win(512, 512), { left: [], right: [], up: [2], down: [] })).toEqual([{ t: win(512, 256), seeds: [255 * 88 + 2] }]);
  });

  it("gives nothing past the raster's edges or for an edge with no filled pixel", () => {
    expect(edgeSeeds(dims, win(0, 0), { left: [1], right: [], up: [1], down: [] })).toEqual([]);
    expect(edgeSeeds(dims, win(512, 512), { left: [], right: [1], up: [], down: [1] })).toEqual([]);
  });
});

describe("inReach", () => {
  it("is true for tiles up to FILL_REACH from the cell's tile each way, and false one further", () => {
    const cell: [number, number] = [256 * 7 + 200, 256 * 7 + 3];
    expect(inReach(cell, 256 * 3, 256 * 11)).toBe(true);
    expect(inReach(cell, 256 * 2, 256 * 7)).toBe(false);
    expect(inReach(cell, 256 * 7, 256 * 12)).toBe(false);
    expect(inReach(cell, 256 * 7, 256 * 7)).toBe(true);
  });
});
