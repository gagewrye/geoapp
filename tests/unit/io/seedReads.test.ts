import { describe, expect, it } from "vitest";
import { initialClasses } from "../../../src/core/classes";
import { tileWindows, type Window } from "../../../src/core/grid";
import { emptyStore } from "../../../src/core/labelStore";
import { seedWindows, sourceCells } from "../../../src/core/seed";
import type { Affine, Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import { importLabels } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Spec 004 criteria 14 (reads) and 16 (the cap, io; spec 014: imports no longer reach it).

const IMAGERY: Grid = { width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] };
/** A generated 900 x 700 EPSG:32633 class raster at 600 m (4 x 3 file windows), inside IMAGERY: 1 on its north-west part, else 5. */
const FILE: Grid = { width: 900, height: 700, epsg: 32633, gt: [230000, 600, 0, 5200000, 0, -600] };
const fileValue = (c: number, r: number) => (c < 300 && r < 200 ? 1 : 5);
const key = (w: Window) => `${w.x0},${w.y0},${w.width},${w.height}`;

/** Logs file ("f") and imagery ("i") reads in order, and the most reads in flight at once. */
function instrumented() {
  const log: string[] = [];
  let inFlight = 0, maxInFlight = 0;
  const track = async <T>(entry: string, read: () => Promise<T>): Promise<T> => {
    log.push(entry);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 0));
    try { return await read(); } finally { inFlight--; }
  };
  const img = fakeSource({ ...IMAGERY, bandCount: 2 }, (b, c, r) => b * 1000 + c + r).source;
  const imagery: RasterSource = { meta: img.meta, readWindow: (x0, y0, w, h) => track(`i ${key({ x0, y0, width: w, height: h })}`, () => img.readWindow(x0, y0, w, h)) };
  const f = fakeLabelSource(FILE, fileValue).source;
  const file: LabelSource = { ...f, read: (w) => track(`f ${key(w)}`, () => f.read(w)) };
  return { imagery, file, log, maxInFlight: () => maxInFlight };
}

/** The 256x256-aligned file windows holding a cell of imagery window w, row-major. */
function fileWindowsOf(w: Window): Window[] {
  const cells = sourceCells(IMAGERY, FILE, w);
  return tileWindows(FILE.width, FILE.height).filter((fw) => {
    for (let i = 0; i < cells.length; i += 2) {
      const c = cells[i]!, r = cells[i + 1]!;
      if (c >= fw.x0 && c < fw.x0 + fw.width && r >= fw.y0 && r < fw.y0 + fw.height) return true;
    }
    return false;
  });
}

describe("reads (criterion 14, as spec 024 amends it)", () => {
  it("one pass, row by row: each window's aligned file windows, then one imagery span per row over the windows the file covers", { timeout: 60_000 }, async () => {
    const { imagery, file, log, maxInFlight } = instrumented();
    const r = await importLabels(imagery, file, [{ value: 1, name: "one" }]);
    expect(typeof r).toBe("object");
    const want: string[] = [];
    let multi = 0;
    const windows = seedWindows(IMAGERY, FILE);
    for (const y0 of [...new Set(windows.map((w) => w.y0))]) {
      const row = windows.filter((w) => w.y0 === y0);
      for (const w of row) {
        const fws = fileWindowsOf(w);
        if (fws.length > 1) multi++;
        want.push(...fws.map((fw) => `f ${key(fw)}`));
      }
      const covered = row.filter((w) => sourceCells(IMAGERY, FILE, w).some((v) => v >= 0));
      if (!covered.length) continue;
      const first = covered[0]!, last = covered.at(-1)!;
      want.push(`i ${key({ x0: first.x0, y0, width: last.x0 + last.width - first.x0, height: first.height })}`);
    }
    expect(log).toEqual(want);
    // the case split is real: some windows need several file windows
    expect(multi).toBeGreaterThan(0);
    expect(maxInFlight()).toBe(1);
  });
});

describe("no label cap on imports (spec 014 supersedes criterion 16's io cap)", () => {
  // 4352 = 17 x 256, so 289 tiles; generated in memory on a grid equal to the imagery's
  const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
  const grid: Grid = { width: 4352, height: 4352, epsg: 32633, gt };

  for (const mode of ["replace"] as const) {
    it(`imports as a base (${mode}), leaving the current store and list unchanged`, { timeout: 120_000 }, async () => {
      const { source: imagery } = fakeSource({ ...grid, bandCount: 1 }, () => 1);
      const { source: file } = fakeLabelSource(grid, () => 1);
      const store = emptyStore(4352, 4352);
      const tile = new Uint8Array(65536).fill(2);
      store.tiles.set("256,256", tile);
      const classes = initialClasses();
      const r = await importLabels(imagery, file, [{ value: 1, name: "new" }]);
      if (typeof r === "string") throw new Error(r);
      expect([...r.store.tiles.keys()]).toEqual([]);
      expect(r.base.count).toBe(4352 * 4352);
      expect(r.pixels).toBe(4352 * 4352);
      expect([...store.tiles.keys()]).toEqual(["256,256"]);
      expect(store.tiles.get("256,256")).toBe(tile);
      expect(tile.every((v) => v === 2)).toBe(true);
      expect(classes).toEqual(initialClasses());
      });
  }
});
