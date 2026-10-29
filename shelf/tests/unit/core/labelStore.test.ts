// Fragment of tests/unit/core/labelStore.test.ts (spec 013): its assertions on shelved functions, to merge back by hand.
import { describe, expect, it } from "vitest";
import { tileWindows, type Window } from "../../../src/core/grid";
import { brush, emptyStore, labelWindows, paintedValues, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { makeTile } from "../helpers/tiles";

/** Masks for every tile of the store, with `nodata(col, row)` pixels set. */
function masksFor(store: LabelStore, nodata: (c: number, r: number) => boolean = () => false): NodataMasks {
  const masks: NodataMasks = new Map();
  for (const w of tileWindows(store.width, store.height)) {
    masks.set(`${w.x0},${w.y0}`, nodataMask(makeTile(w.x0, w.y0, w.width, w.height, 1, (_k, c, r) => (nodata(c, r) ? NaN : 1))));
  }
  return masks;
}

const win = (x0: number, y0: number, width: number, height = width): Window => ({ x0, y0, width, height });

describe("labelWindows", () => {
  it("lists the stored tiles' windows row-major, clipped at edges", () => {
    const s = emptyStore(600, 300);
    const m = masksFor(s);
    for (const [c, r] of [[590, 290], [5, 290], [300, 5], [5, 5]] as const) brush(s, m, win(c, r, 1), 1, false);
    expect(labelWindows(s)).toEqual([win(0, 0, 256), win(256, 0, 256), win(0, 256, 256, 44), win(512, 256, 88, 44)]);
  });
});

describe("paintedValues", () => {
  it("is empty for an empty store", () => {
    expect(paintedValues(emptyStore(600, 300))).toEqual(new Set());
  });

  it("gives the values painted across tiles", () => {
    const s = emptyStore(600, 300);
    const m = masksFor(s);
    brush(s, m, win(10, 10, 7), 1, false);
    brush(s, m, win(300, 10, 7), 3, false);
    expect(s.tiles.size).toBe(2);
    expect(paintedValues(s)).toEqual(new Set([1, 3]));
  });
});
