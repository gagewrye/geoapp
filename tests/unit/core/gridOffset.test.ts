import { describe, expect, it } from "vitest";
import { applyAffine, invertAffine } from "../../../src/core/crs";
import { gridOffset, sourceCells } from "../../../src/core/seed";
import type { Grid } from "../../../src/core/types";

// Spec 024 criterion 1: the equal-grid fast path.

const DST: Grid = { width: 700, height: 600, epsg: 32618, gt: [300000, 0.1, 0, 5000000, 0, -0.1] };
const shifted = (dx: number, dy: number, over: Partial<Grid> = {}): Grid => {
  const [x, y] = applyAffine(DST.gt, dx, dy);
  return { ...DST, width: 500, height: 450, gt: [x, DST.gt[1], DST.gt[2], y, DST.gt[4], DST.gt[5]], ...over };
};
/** sourceCells by projection alone: dst pixel centre to src pixel, as spec 004 does for equal CRSs. */
function projected(dst: Grid, src: Grid, w: { x0: number; y0: number; width: number; height: number }): Int32Array {
  const out = new Int32Array(2 * w.width * w.height);
  let i = 0;
  for (let r = w.y0; r < w.y0 + w.height; r++) for (let c = w.x0; c < w.x0 + w.width; c++) {
    const [fc, fr] = invertAffine(src.gt, ...applyAffine(dst.gt, c + 0.5, r + 0.5));
    const col = Math.floor(fc), row = Math.floor(fr), on = col >= 0 && col < src.width && row >= 0 && row < src.height;
    out[i++] = on ? col : -1; out[i++] = on ? row : -1;
  }
  return out;
}

describe("gridOffset", () => {
  it("gives the whole-pixel offset of a shifted equal grid, either way", () => {
    expect(gridOffset(DST, shifted(0, 0))).toEqual([0, 0]);
    expect(gridOffset(DST, shifted(37, 120))).toEqual([37, 120]);
    expect(gridOffset(DST, shifted(-300, -5))).toEqual([-300, -5]);
  });

  it("is null for another CRS, pixel size or rotation, or a sub-pixel shift", () => {
    expect(gridOffset(DST, shifted(3, 4, { epsg: 32619 }))).toBeNull();
    expect(gridOffset(DST, { ...shifted(3, 4), gt: [DST.gt[0], 0.2, 0, DST.gt[3], 0, -0.2] })).toBeNull();
    expect(gridOffset(DST, { ...shifted(3, 4), gt: [DST.gt[0], 0.1, 0.01, DST.gt[3], 0.01, -0.1] })).toBeNull();
    expect(gridOffset(DST, shifted(3.5, 4))).toBeNull();
    expect(gridOffset(DST, shifted(3, 4.01))).toBeNull();
  });

  it("with an offset, sourceCells equals the projected cells pixel for pixel", () => {
    for (const [dx, dy] of [[0, 0], [37, 120], [-300, -5], [650, 590]] as const) {
      const src = shifted(dx, dy);
      expect(gridOffset(DST, src)).not.toBeNull();
      for (const w of [{ x0: 0, y0: 0, width: 256, height: 256 }, { x0: 256, y0: 512, width: 256, height: 88 }, { x0: 512, y0: 256, width: 188, height: 256 }]) {
        expect(Array.from(sourceCells(DST, src, w)), `${dx},${dy} ${w.x0},${w.y0}`).toEqual(Array.from(projected(DST, src, w)));
      }
    }
  });
});
