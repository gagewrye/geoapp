import { describe, expect, it } from "vitest";
import { brush, emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { train } from "../../../src/io/pipeline";
import type { RasterSource } from "../../../src/io/source";
import { fakeSource } from "../helpers/sources";

// Tester: spec 003 Training edge cases (empty store, partial tiles, band-specific nodata) and the
// store changing while training awaits its reads (the brush stays live during Train).

const allValid = () => new Map(Array.from({ length: 64 }, (_, i) => [`${(i % 8) * 256},${Math.floor(i / 8) * 256}`, new Uint8Array(8192)]));
const paint = (s: LabelStore, x0: number, y0: number, w: number, h: number, v: number) => brush(s, allValid(), { x0, y0, width: w, height: h }, v, false);

describe("train from the label store (criterion 15/19, tester)", () => {
  it("partial edge tiles of a 300x260 raster: N counts every labelled pixel, reads are the clipped windows", async () => {
    const { source, reads } = fakeSource({ width: 300, height: 260, bandCount: 2 }, (b, c) => (b === 0 ? (c < 150 ? 1 : 9) : c % 3));
    const s = emptyStore(300, 260);
    paint(s, 250, 250, 50, 10, 1); // 4 tiles, 3 of them partial
    paint(s, 0, 0, 5, 5, 2);
    const r = await train(source, s, ["a", "b"], { epochs: 5 });
    expect(r).not.toBe("no samples");
    if (r === "no samples") return;
    expect(r.samples).toBe(50 * 10 + 25);
    expect(reads.map((w) => [w.x0, w.y0, w.width, w.height])).toEqual([[0, 0, 256, 256], [256, 0, 44, 256], [0, 256, 256, 4], [256, 256, 44, 4]]);
  });

  it("band-specific nodata (band 3 of 4 only) is dropped from N, other bands' equal values aren't nodata", async () => {
    const nd = (c: number, r: number) => c >= 10 && c < 20 && r >= 10 && r < 20;
    const { source } = fakeSource({ width: 256, height: 256, bandCount: 4, nodata: -5 }, (b, c, r) => (b === 2 && nd(c, r) ? -5 : b === 3 ? (c < 128 ? 0 : 1) : c + r));
    const s = emptyStore(256, 256);
    paint(s, 0, 0, 30, 30, 1);
    paint(s, 200, 200, 10, 10, 2);
    const r = await train(source, s, ["a", "b"], { epochs: 5 });
    if (r === "no samples") throw new Error("no samples");
    expect(r.samples).toBe(900 - 100 + 100);
    expect(r.model.bands).toEqual([1, 2, 3, 4]);
  });

  it("an empty store gives \"no samples\" and reads nothing (the ui refuses earlier with Paint at least two classes)", async () => {
    const { source, reads } = fakeSource({ width: 512, height: 512 }, () => 1);
    expect(await train(source, emptyStore(512, 512), ["a", "b"])).toBe("no samples");
    expect(reads).toEqual([]);
  });

  // Train isn't locked while it reads, and the brush stays live, so an erase can empty a stored tile
  // mid-training; train samples the labels as they were when it was called.
  it("a stored tile erased to empty while training awaits an earlier read doesn't break training", async () => {
    const { source: inner } = fakeSource({ width: 1024, height: 256, bandCount: 1 }, (_b, c) => c);
    const s = emptyStore(1024, 256);
    paint(s, 0, 0, 10, 10, 1);
    paint(s, 600, 0, 10, 10, 2);
    paint(s, 900, 0, 10, 10, 1);
    const source: RasterSource = {
      meta: inner.meta,
      async readWindow(x0, y0, w, h) {
        if (x0 === 0) brush(s, new Map(), { x0: 512, y0: 0, width: 256, height: 256 }, 2, true); // the user erases tile 512,0
        return inner.readWindow(x0, y0, w, h);
      },
    };
    const r = await train(source, s, ["a", "b"], { epochs: 5 });
    expect(r === "no samples" ? 0 : r.samples).toBeGreaterThan(0);
  });
});
