import { describe, expect, it } from "vitest";
import { blockIndices, groupReads } from "../../../src/core/blocks";
import { decodedBytes, type Block } from "../../../src/core/imagery";

const tile: Block = { width: 256, height: 256, bytes: 256 * 256 * 4 };

describe("blockIndices", () => {
  it("lists the blocks windows touch, row-major and once each, clipped to the image", () => {
    // 1000 x 700 in 256² tiles: 4 across, 3 down
    expect(blockIndices([{ x0: 0, y0: 0, width: 256, height: 256 }], tile, 1000, 700)).toEqual([0]);
    expect(blockIndices([{ x0: 200, y0: 250, width: 100, height: 20 }, { x0: 512, y0: 256, width: 256, height: 256 }], tile, 1000, 700)).toEqual([0, 1, 4, 5, 6]);
    expect(blockIndices([{ x0: 768, y0: 512, width: 512, height: 512 }], tile, 1000, 700)).toEqual([11]);
  });

  it("gives a planar file's blocks for each plane read, a plane after another", () => {
    expect(blockIndices([{ x0: 256, y0: 0, width: 256, height: 256 }], tile, 1000, 700, [0, 3])).toEqual([1, 37]);
  });

  it("gives strips as blocks as wide as the image", () => {
    expect(blockIndices([{ x0: 300, y0: 10, width: 10, height: 6 }], { width: 1000, height: 4 }, 1000, 700)).toEqual([2, 3]);
  });
});

describe("groupReads", () => {
  it("groups reads in order, each group decoding at most max bytes, a read over max alone", () => {
    const reads = [0, 256, 512, 768].map((x0) => ({ x0, y0: 0, width: 256, height: 256 }));
    const groups = groupReads(reads, tile, 1000, 700, 2 * tile.bytes);
    expect(groups).toEqual([reads.slice(0, 2), reads.slice(2)]);
    for (const g of groups) expect(g.reduce((s, w) => s + decodedBytes(w, tile, 1000, 700), 0)).toBeLessThanOrEqual(2 * tile.bytes);
    expect(groupReads(reads, tile, 1000, 700, 1)).toEqual(reads.map((r) => [r]));
    expect(groupReads([], tile, 1000, 700, 1)).toEqual([]);
  });
});
