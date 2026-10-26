import { describe, expect, it } from "vitest";
import { warpPreview } from "../../../src/core/warp";
import type { Affine } from "../../../src/core/types";
import { makeTile } from "../helpers/tiles";

const R = 6378137;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

describe("warpPreview (criterion 4)", () => {
  // EPSG:32633: (16.5E, 47.25N) is (613504.343, 5234037.466) by an independent Kruger series.
  const gt: Affine = [613504.343 - 100.5 * 30, 30, 0, 5234037.466 + 100.5 * 30, 0, -30];
  const src = makeTile(0, 0, 200, 200, 1, (_, c, r) => (Math.abs(c - 100) <= 2 && Math.abs(r - 100) <= 2 ? 1000 : 0));
  const out = warpPreview(src, gt, 32633, 150);

  it("places a known feature within 1 preview pixel of its reference lon/lat", () => {
    const [tl, , br] = out.corners as [[number, number], [number, number], [number, number]];
    const px = ((16.5 - tl[0]) / (br[0] - tl[0])) * out.width;
    const py = ((mercY(tl[1]) - mercY(47.25)) / (mercY(tl[1]) - mercY(br[1]))) * out.height;
    let sx = 0, sy = 0, n = 0;
    for (let v = 0; v < out.height; v++) for (let u = 0; u < out.width; u++) {
      if (out.rgba[4 * (v * out.width + u)] === 255) { sx += u + 0.5; sy += v + 0.5; n++; }
    }
    expect(n).toBeGreaterThan(0);
    expect(Math.hypot(sx / n - px, sy / n - py)).toBeLessThanOrEqual(1);
  });

  it("returns corners forming an axis-aligned rectangle in Mercator", () => {
    const [tl, tr, br, bl] = out.corners as [number, number][];
    expect(tl![0]).toBe(bl![0]);
    expect(tr![0]).toBe(br![0]);
    expect(tl![1]).toBe(tr![1]);
    expect(bl![1]).toBe(br![1]);
    expect(tr![0]).toBeGreaterThan(tl![0]);
    expect(tl![1]).toBeGreaterThan(bl![1]);
    expect(Math.max(out.width, out.height)).toBe(150);
    expect(out.rgba).toHaveLength(out.width * out.height * 4);
  });

  it("is greyscale for one band, transparent outside the raster and at nodata", () => {
    const i = 4 * (Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2));
    expect([out.rgba[i], out.rgba[i + 1], out.rgba[i + 2], out.rgba[i + 3]]).toEqual([255, 255, 255, 255]);
    expect(out.rgba[3]).toBe(0); // rotated UTM footprint leaves the bbox corner empty
    const nd = makeTile(0, 0, 4, 4, 1, (_, c) => (c === 0 ? -1 : c), -1);
    const w = warpPreview(nd, [0, 1, 0, 4, 0, -1], 4326, 4);
    expect(w.rgba[3]).toBe(0);
    expect(w.rgba[4 * 3 + 3]).toBe(255);
  });

  it("uses bands 1-3 as RGB", () => {
    const t = makeTile(0, 0, 2, 1, 3, (k, c) => (c === 0 ? 0 : [10, 20, 30][k]!));
    t.bands[0]![0] = 10; // band 1 constant over the tile
    const w = warpPreview(t, [0, 1, 0, 1, 0, -1], 4326, 2);
    expect(Array.from(w.rgba.subarray(4, 8))).toEqual([0, 255, 255, 255]);
  });

  it("clips the preview to +-MAX_LAT", () => {
    const t = makeTile(0, 0, 10, 10, 1, () => 1);
    const w = warpPreview(t, [0, 1, 0, 90, 0, -18], 4326, 10);
    expect(w.corners[0]![1]).toBeCloseTo(85.051129, 5);
    expect(w.corners[2]![1]).toBeCloseTo(-85.051129, 5);
  });
});
