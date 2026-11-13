import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { brush, emptyStore, tileWindow, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { footprint } from "../../../src/core/pixel";
import { makeTile } from "../helpers/tiles";

// Spec 003 criteria 2 and 4: a brush dab on partial edge tiles skips nodata, refuses bad values, and changes nothing when it throws.

/** Every mask of a store whose nodata(col, row) pixels are set, built from 2-band tiles (band 2 nodata -9). */
function masks(store: LabelStore, nodata: (c: number, r: number) => boolean): NodataMasks {
  const m: NodataMasks = new Map();
  for (const w of tileWindows(store.width, store.height))
    m.set(`${w.x0},${w.y0}`, nodataMask(makeTile(w.x0, w.y0, w.width, w.height, 2, (k, c, r) => (k === 1 && nodata(c, r) ? -9 : 1), -9)));
  return m;
}
const label = (s: LabelStore, c: number, r: number) => {
  const w = tileWindow(s, c - (c % 256), r - (r % 256));
  return s.tiles.get(`${w.x0},${w.y0}`)?.[(r - w.y0) * w.width + (c - w.x0)] ?? 0;
};

describe("brush on partial edge tiles and with odd inputs (criteria 2, 4)", () => {
  it("a size-127 dab at the bottom-right corner of a 300x260 raster labels exactly the clipped window minus nodata in all 4 (partial) tiles", () => {
    const s = emptyStore(300, 260);
    const nd = (c: number, r: number) => (c + 3 * r) % 11 === 0 || (c >= 280 && r >= 250);
    const m = masks(s, nd);
    const w = footprint(s, 299, 259, 127)!;
    brush(s, m, w, 4, false);
    for (let r = 0; r < 260; r++) for (let c = 0; c < 300; c++) {
      const inW = c >= w.x0 && r >= w.y0;
      expect(label(s, c, r)).toBe(inW && !nd(c, r) ? 4 : 0);
    }
    expect([...s.tiles.keys()].sort()).toEqual(["0,0", "0,256", "256,0", "256,256"]);
    for (const [k, t] of s.tiles) { const [x, y] = k.split(",").map(Number) as [number, number]; const tw = tileWindow(s, x, y); expect(t).toHaveLength(tw.width * tw.height); }
  });

  it("refuses label values outside 1..255 before touching the store", () => {
    const s = emptyStore(100, 100);
    const m = masks(s, () => false);
    for (const v of [0, 256, 1.5, -1, NaN]) expect(() => brush(s, m, { x0: 0, y0: 0, width: 3, height: 3 }, v, false)).toThrow(/1\.\.255/);
    expect(s.tiles.size).toBe(0);
  });

  it("a paint that throws for a missing mask in its second tile has changed nothing in its first", () => {
    const s = emptyStore(600, 300);
    const m = masks(s, () => false);
    m.delete("256,0");
    expect(() => brush(s, m, { x0: 250, y0: 0, width: 10, height: 5 }, 1, false)).toThrow(/mask/);
    expect(s.tiles.size).toBe(0);
  });
});
