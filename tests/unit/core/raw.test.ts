import { describe, expect, it } from "vitest";
import { decodedBytes } from "../../../src/core/imagery";
import { copySamples, rowRanges, type RawLayout } from "../../../src/core/raw";

// Spec 028 criterion 2 (rowRanges on Chunk 11's layout) and the pure parts of criterion 1.

/** Chunk 11: 36916 x 16064 RGBA u8 in 1-row strips of 147,664 B, stored back to back. */
const W11 = 36916, H11 = 16064, BPP = 4;
const chunk11: RawLayout = {
  width: W11, height: H11, blockWidth: W11, blockHeight: 1, bytesPerPixel: BPP,
  offsets: Float64Array.from({ length: H11 }, (_, i) => 8 + i * W11 * BPP),
  counts: new Float64Array(H11).fill(W11 * BPP),
};

describe("rowRanges", () => {
  it("reads 256 KiB for a 256² window of Chunk 11, where geotiff decodes 256 whole strips (37.8 MB)", () => {
    const ranges = rowRanges(chunk11, 20000, 9000, 256, 256);
    expect(ranges).toHaveLength(256);
    expect(ranges.reduce((s, r) => s + r.length, 0)).toBe(256 * 1024);
    expect(ranges[0]).toMatchObject({ offset: 8 + 9000 * W11 * BPP + 20000 * BPP, length: 1024, row: 9000, x0: 20000, width: 256 });
    expect(decodedBytes({ x0: 20000, y0: 9000, width: 256, height: 256 }, { width: W11, height: 1, bytes: W11 * BPP }, W11, H11)).toBe(256 * W11 * BPP);
  });

  it("splits each row at tile edges, inside each tile's padded rows, and clips to the image", () => {
    // 600 x 300, 256² tiles of 2 B/px: 3 x 2 tiles, the last column and row padded
    const layout: RawLayout = { width: 600, height: 300, blockWidth: 256, blockHeight: 256, bytesPerPixel: 2,
      offsets: [0, 1, 2, 3, 4, 5].map((i) => 1000 + i * 256 * 256 * 2), counts: new Array(6).fill(256 * 256 * 2) };
    const r = rowRanges(layout, 200, 250, 500, 100);
    expect(r).toHaveLength(50 * 3); // rows 250-299, each in 3 tiles; columns 600-699 are off the image
    const tileRow = (t: number, row: number) => 1000 + t * 256 * 256 * 2 + row * 256 * 2;
    expect(r[0]).toEqual({ offset: tileRow(0, 250) + 200 * 2, length: 56 * 2, row: 250, x0: 200, width: 56 });
    expect(r[1]).toEqual({ offset: tileRow(1, 250), length: 256 * 2, row: 250, x0: 256, width: 256 });
    expect(r[2]).toEqual({ offset: tileRow(2, 250), length: 88 * 2, row: 250, x0: 512, width: 88 });
    expect(r[3]).toEqual({ offset: tileRow(0, 251) + 200 * 2, length: 56 * 2, row: 251, x0: 200, width: 56 });
    expect(r[18]).toEqual({ offset: tileRow(3, 0) + 200 * 2, length: 56 * 2, row: 256, x0: 200, width: 56 });
  });

  it("gives a zero length for a block stored with no bytes (filled, as geotiff does), and throws for a short block", () => {
    const layout: RawLayout = { width: 10, height: 4, blockWidth: 10, blockHeight: 2, bytesPerPixel: 1, offsets: [100, 0], counts: [20, 0] };
    expect(rowRanges(layout, 2, 1, 3, 2)).toEqual([{ offset: 112, length: 3, row: 1, x0: 2, width: 3 }, { offset: 0, length: 0, row: 2, x0: 2, width: 3 }]);
    expect(() => rowRanges({ ...layout, counts: [14, 0] }, 2, 1, 3, 1)).toThrow(RangeError);
    expect(rowRanges({ ...layout, counts: [15, 0] }, 2, 1, 3, 1)).toHaveLength(1); // ends at the block's last byte
  });
});

describe("copySamples", () => {
  it("copies the asked samples of a row's pixels into their place in the window", () => {
    // a row of 3 pixels of 4 uint16 samples: sample s of pixel p is 100p + s
    const buf = Uint16Array.from({ length: 12 }, (_, i) => 100 * Math.floor(i / 4) + (i % 4)).buffer;
    const out = [new Uint16Array(4 * 2), new Uint16Array(4 * 2)];
    copySamples(buf, { offset: 0, length: 24, row: 11, x0: 6, width: 3 }, 4, [3, 0], out, 5, 10, 4, 0);
    expect([...out[0]!]).toEqual([0, 0, 0, 0, 0, 3, 103, 203]);
    expect([...out[1]!]).toEqual([0, 0, 0, 0, 0, 0, 100, 200]);
  });

  it("fills a row of a block stored with no bytes", () => {
    const out = [new Float32Array(3)];
    copySamples(new ArrayBuffer(0), { offset: 0, length: 0, row: 0, x0: 1, width: 2 }, 2, [1], out, 0, 0, 3, -9);
    expect([...out[0]!]).toEqual([0, -9, -9]);
  });
});
