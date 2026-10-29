// Fragment of tests/unit/core/brush.tester.test.ts (spec 013): its labelWindows assertion, to merge back by hand.
import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { brush, emptyStore, labelWindows, tileWindow, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { footprint } from "../../../src/core/pixel";
import { makeTile } from "../helpers/tiles";

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

describe("brush on partial edge tiles and with odd inputs (criterion 4, tester)", () => {
  it("a size-127 dab at the bottom-right corner of a 300x260 raster labels exactly the clipped window minus nodata in all 4 (partial) tiles", () => {
    const s = emptyStore(300, 260);
    const nd = (c: number, r: number) => (c + 3 * r) % 11 === 0 || (c >= 280 && r >= 250);
    const m = masks(s, nd);
    const w = footprint(s, 299, 259, 127)!;
    expect(brush(s, m, w, 4, false)).toBe("ok");
    for (let r = 0; r < 260; r++) for (let c = 0; c < 300; c++) {
      const inW = c >= w.x0 && r >= w.y0;
      expect(label(s, c, r)).toBe(inW && !nd(c, r) ? 4 : 0);
    }
    expect(labelWindows(s)).toEqual([
      { x0: 0, y0: 0, width: 256, height: 256 }, { x0: 256, y0: 0, width: 44, height: 256 },
      { x0: 0, y0: 256, width: 256, height: 4 }, { x0: 256, y0: 256, width: 44, height: 4 },
    ]);
    for (const [k, t] of s.tiles) { const [x, y] = k.split(",").map(Number) as [number, number]; const tw = tileWindow(s, x, y); expect(t).toHaveLength(tw.width * tw.height); }
  });
});
