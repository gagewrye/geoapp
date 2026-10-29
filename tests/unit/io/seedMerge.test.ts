import { describe, expect, it } from "vitest";
import { paletteColour, type LabelClass } from "../../../src/core/classes";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { importLabels, type SeedOutcome } from "../../../src/io/seeding";
import { fakeLabelSource } from "../helpers/labelFiles";
import { effectiveTiles } from "../helpers/effective";
import { fakeSource } from "../helpers/sources";

// Spec 004 Merge or Replace (criterion 16's rules, here at the io level): new labels are built
// beside the current ones, which change only when the caller swaps them in.

const GRID: Grid = { width: 512, height: 300, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
const imagery = () => fakeSource({ ...GRID, bandCount: 1 }, () => 1).source;
const file = (f: (c: number, r: number) => number = (c) => (c < 300 ? 3 : 7)) => fakeLabelSource(GRID, f).source;
const MAP = [{ value: 3, name: "B" }, { value: 7, name: "C" }];
const A: LabelClass = { name: "A", colour: "#aa0000" }, B: LabelClass = { name: "B", colour: "#00bb00" };

/** Rows 0..9: value 1 (A) on cols 0..99, value 2 (B) on cols 100..149; 1500 pixels in tile 0,0. */
function painted(): LabelStore {
  const store = emptyStore(GRID.width, GRID.height);
  const t = new Uint8Array(256 * 256);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 150; c++) t[r * 256 + c] = c < 100 ? 1 : 2;
  store.tiles.set("0,0", t);
  return store;
}
/** The effective label at (c, r) (spec 014: stored tile, else the mask's), from effectiveTiles. */
const valueAt = (tiles: Map<string, Uint8Array>, c: number, r: number) => {
  const x0 = c - (c % 256), y0 = r - (r % 256), w = Math.min(256, GRID.width - x0);
  return tiles.get(`${x0},${y0}`)![(r - y0) * w + (c - x0)]!;
};
const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };

describe("Merge", () => {
  it("keeps every painted pixel, labels only unlabelled ones, appends only new names, and counts only new pixels", async () => {
    const store = painted(), classes = [A, B];
    const before = store.tiles.get("0,0")!.slice();
    const r = ok(await importLabels(imagery(), file(), MAP, { store, classes }, "merge"));
    expect(r.classes).toEqual([A, B, { name: "C", colour: paletteColour(2) }]);
    expect(r.pixels).toBe(512 * 300 - 1500);
    expect(r.classCount).toBe(2);
    const tiles = await effectiveTiles(imagery(), r);
    let bad = 0;
    for (let row = 0; row < 300; row++) for (let c = 0; c < 512; c++) {
      const want = row < 10 && c < 150 ? (c < 100 ? 1 : 2) : c < 300 ? 2 : 3;
      if (valueAt(tiles, c, row) !== want) bad++;
    }
    expect(bad).toBe(0);
    // the current labels are untouched until the caller swaps the new ones in
    expect(store.tiles.size).toBe(1);
    expect(Buffer.from(store.tiles.get("0,0")!).equals(Buffer.from(before))).toBe(true);
    expect(classes).toEqual([A, B]);
    // every stored value has a class (spec 003 review handoff)
    expect([...tiles.values()].reduce((m, t) => t.reduce((a, v) => Math.max(a, v), m), 0)).toBeLessThanOrEqual(r.classes.length);
  });

  it("gives \"empty\" when every seeded pixel is already labelled, and when the file is all unlisted", async () => {
    const store = emptyStore(GRID.width, GRID.height);
    for (const w of tileWindows(GRID.width, GRID.height)) store.tiles.set(`${w.x0},${w.y0}`, new Uint8Array(w.width * w.height).fill(1));
    expect(await importLabels(imagery(), file(), MAP, { store, classes: [A] }, "merge")).toBe("empty");
    expect(await importLabels(imagery(), file(() => 9), MAP, { store: emptyStore(512, 300), classes: [A] }, "merge")).toBe("empty");
  });

  it("gives \"too many\" past 255 classes and changes nothing", async () => {
    const classes = Array.from({ length: 254 }, (_, i) => ({ name: `c${i}`, colour: "#000000" }));
    const store = painted();
    expect(await importLabels(imagery(), file(), MAP, { store, classes }, "merge")).toBe("too many");
    expect(classes).toHaveLength(254);
    expect(store.tiles.size).toBe(1);
  });
});

describe("Replace", () => {
  it("drops the painted labels and classes: the list is the incoming one", async () => {
    const r = ok(await importLabels(imagery(), file(), MAP, { store: painted(), classes: [A, B] }, "replace"));
    expect(r.classes).toEqual([{ name: "B", colour: paletteColour(0) }, { name: "C", colour: paletteColour(1) }]);
    expect(r.pixels).toBe(512 * 300);
    const tiles = await effectiveTiles(imagery(), r);
    expect([valueAt(tiles, 0, 0), valueAt(tiles, 299, 5), valueAt(tiles, 300, 5)]).toEqual([1, 1, 2]);
    expect(r.store.tiles.size).toBe(0);
  });
});
