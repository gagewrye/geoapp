import { describe, expect, it } from "vitest";
import { overlayIndex, paintOverlay } from "../../../src/core/overlay";
import { TILE_SIZE, type Affine, type Grid } from "../../../src/core/types";
import { warpPreview } from "../../../src/core/warp";
import { makeTile } from "../helpers/tiles";

const R = 6378137;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

// EPSG:32633: (16.5E, 47.25N) is (613504.343, 5234037.466) by an independent Kruger series; it is
// the centre of pixel (356, 300), inside tile 256,256.
const gt: Affine = [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30];
const grid: Grid = { epsg: 32633, gt, width: 600, height: 520 };
const w = { x0: 256, y0: 256, width: 256, height: 256 };

describe("overlayIndex + paintOverlay (criterion 6)", () => {
  const ov = overlayIndex(w, grid, TILE_SIZE);
  const labels = new Uint8Array(w.width * w.height);
  for (let r = 298; r <= 302; r++) for (let c = 354; c <= 358; c++) labels[(r - 256) * 256 + (c - 256)] = 2;
  const colours = ["#102030", "#ff8001"];
  const rgba = new Uint8ClampedArray(ov.width * ov.height * 4).fill(77);
  paintOverlay(ov.index, labels, colours, rgba);

  it("lands a labelled pixel within 1 overlay pixel of its reference lon/lat", () => {
    const [tl, , br] = ov.corners as [[number, number], [number, number], [number, number]];
    const px = ((16.5 - tl[0]) / (br[0] - tl[0])) * ov.width;
    const py = ((mercY(tl[1]) - mercY(47.25)) / (mercY(tl[1]) - mercY(br[1]))) * ov.height;
    let sx = 0, sy = 0, n = 0;
    for (let v = 0; v < ov.height; v++) for (let u = 0; u < ov.width; u++) {
      if (rgba[4 * (v * ov.width + u) + 3] === 255) { sx += u + 0.5; sy += v + 0.5; n++; }
    }
    expect(n).toBeGreaterThan(0);
    expect(Math.hypot(sx / n - px, sy / n - py)).toBeLessThanOrEqual(1);
  });

  it("has corners forming an axis-aligned Mercator rectangle (TL, TR, BR, BL), at most maxSide", () => {
    const [tl, tr, br, bl] = ov.corners as [number, number][];
    expect(tl![0]).toBe(bl![0]);
    expect(tr![0]).toBe(br![0]);
    expect(tl![1]).toBe(tr![1]);
    expect(bl![1]).toBe(br![1]);
    expect(tr![0]).toBeGreaterThan(tl![0]);
    expect(tl![1]).toBeGreaterThan(bl![1]);
    expect(Math.max(ov.width, ov.height)).toBe(TILE_SIZE);
    expect(ov.index).toHaveLength(ov.width * ov.height);
  });

  it("uses the same grid and corners as warpPreview of the window", () => {
    const t = makeTile(w.x0, w.y0, w.width, w.height, 1, (_k, c, r) => c * 1000 + r);
    const p = warpPreview(t, gt, 32633, TILE_SIZE);
    expect([p.width, p.height]).toEqual([ov.width, ov.height]);
    expect(p.corners).toEqual(ov.corners);
    for (let i = 0; i < ov.index.length; i++) expect(p.rgba[4 * i + 3] === 255).toBe(ov.index[i]! >= 0);
  });

  it("indexes into w's tile and gives -1 off it", () => {
    let inside = 0;
    for (const k of ov.index) {
      expect(k).toBeGreaterThanOrEqual(-1);
      expect(k).toBeLessThan(w.width * w.height);
      if (k >= 0) inside++;
    }
    expect(inside).toBeGreaterThan(0);
    expect(ov.index[0]).toBe(-1); // the rotated UTM footprint leaves the bbox corner empty
  });

  it("gives labelled pixels exactly the class colour with alpha 255 and all others alpha 0", () => {
    let painted = 0;
    for (let i = 0; i < ov.index.length; i++) {
      const k = ov.index[i]!;
      const px = Array.from(rgba.subarray(4 * i, 4 * i + 4));
      if (k >= 0 && labels[k]! > 0) { expect(px).toEqual([255, 128, 1, 255]); painted++; }
      else expect(px[3]).toBe(0);
    }
    expect(painted).toBeGreaterThan(0);
  });

  it("repaints with new colours and clears pixels whose label went to 0", () => {
    const l = labels.slice();
    const k = ov.index.find((x) => x >= 0 && l[x]! > 0)!;
    l[k] = 1;
    const out = new Uint8ClampedArray(rgba);
    paintOverlay(ov.index, l, ["#00ff00", "#0000ff"], out);
    const i = ov.index.indexOf(k);
    expect(Array.from(out.subarray(4 * i, 4 * i + 4))).toEqual([0, 255, 0, 255]);
    l.fill(0);
    paintOverlay(ov.index, l, colours, out);
    for (let j = 3; j < out.length; j += 4) expect(out[j]).toBe(0);
  });
});
