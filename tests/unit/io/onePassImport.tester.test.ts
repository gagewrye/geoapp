import { describe, expect, it, vi } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { applyAffine } from "../../../src/core/crs";
import { decodedBytes, MAX_READ_BYTES } from "../../../src/core/imagery";
import type { Grid } from "../../../src/core/types";
import { openLabelFile, openLabelTiff } from "../../../src/io/labelFile";
import { importLabels } from "../../../src/io/seeding";
import { fakeLabelSource } from "../helpers/labelFiles";
import { samplesSource } from "../helpers/sources";
import { uint8Tiff } from "../helpers/tiffFixtures";
import { twoPassImport } from "../helpers/twoPassImport";

// Spec 024, tester edge cases: empty, single-class and "too many" files against the two-pass oracle; criterion 3
// through the real label-file reader (geotiff strips) and its blob bytes; criterion 4 with an all-nodata gap window.

const GRID: Grid = { width: 900, height: 600, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
const GEO = { epsg: GRID.epsg, gt: GRID.gt };
const at = (dx: number, dy: number, w: number, h: number): Grid => {
  const [x, y] = applyAffine(GRID.gt, dx, dy);
  return { width: w, height: h, epsg: 32633, gt: [x, 10, 0, y, 0, -10] };
};
const stripImagery = () => samplesSource({ ...GRID, bandCount: 2, nodata: 0, float: false, alpha: null }, (k, c, r) => ((c * 7 + r * 3 + k) % 13 === 0 ? 0 : 5), { width: 900, height: 1, bytes: 1800 });

describe("outcomes equal the two-pass import", () => {
  for (const [name, f, nodata, grid] of [
    ["an all-nodata file", () => 255, 255, at(100, 50, 500, 400)],
    ["a single-class file", () => 4, 255, at(-30, -20, 1000, 700)],
    ["a file of all 256 values, no nodata (too many)", (c: number, r: number) => (c + r * 7) % 256, null, GRID],
    ["a file of one value, partly its nodata, on the imagery's partial edge windows", (c: number) => (c < 850 ? 255 : 2), 255, GRID],
  ] as const) {
    it(name, async () => {
      const file = fakeLabelSource(grid, f, nodata).source;
      const want = await twoPassImport(stripImagery().source, file, null);
      const got = await importLabels(stripImagery().source, file, null);
      if (typeof want === "string" || typeof got === "string") { expect(got).toBe(want); return; }
      expect(got.classes).toEqual(want.classes);
      expect([got.pixels, [...got.base.windows].sort()]).toEqual([want.count, [...want.windows].sort()]);
      expect(Buffer.from(got.base.preview.values).equals(Buffer.from(want.preview))).toBe(true);
    });
  }

  it("an all-nodata file reads no imagery", async () => {
    const { source, reads } = stripImagery();
    expect(await importLabels(source, fakeLabelSource(GRID, () => 255, 255).source, null)).toBe("empty");
    expect(reads).toEqual([]);
  });
});

/** A 1-row-strip Uint8 label file on the imagery grid. */
const stripFile = (g: Grid = GRID) => uint8Tiff([{ width: g.width, height: g.height, bands: 1, value: (_k, c, r) => (c >> 7) + (r >> 6) & 3, layout: { rows: 1 } }], { epsg: g.epsg, gt: g.gt });

describe("criterion 3 through the real label-file reader", () => {
  it("geotiff decodes each strip at most once per import, every read within MAX_READ_BYTES", async () => {
    const tiff = await fromArrayBuffer(stripFile());
    const img = await tiff.getImage(0);
    const spy = vi.spyOn(img, "readRasters");
    tiff.getImage = async () => img;
    const file = await openLabelTiff(tiff);
    spy.mockClear();
    expect(typeof await importLabels(stripImagery().source, file, null)).not.toBe("string");
    const rows = new Map<number, number>();
    for (const [o] of spy.mock.calls) {
      const [x0, y0, x1, y1] = (o as { window: number[] }).window as [number, number, number, number];
      expect(decodedBytes({ x0, y0, width: x1 - x0, height: y1 - y0 }, { width: GRID.width, height: 1, bytes: GRID.width }, GRID.width, GRID.height)).toBeLessThanOrEqual(MAX_READ_BYTES);
      for (let y = y0; y < y1; y++) rows.set(y, (rows.get(y) ?? 0) + 1);
    }
    expect(rows.size).toBe(GRID.height);
    expect(Math.max(...rows.values())).toBe(1);
  });

  it("through a Blob, the import reads at most 1.2x the file's bytes", async () => {
    const buf = stripFile(), blob = new Blob([buf]);
    let bytes = 0;
    const slice = blob.slice.bind(blob);
    blob.slice = (s?: number, e?: number, t?: string) => { const p = slice(s, e, t); bytes += p.size; return p; };
    const file = await openLabelFile(blob);
    expect(typeof await importLabels(stripImagery().source, file, null)).not.toBe("string");
    expect(bytes).toBeLessThanOrEqual(1.2 * buf.byteLength);
  });
});

describe("criterion 4: tiled imagery", () => {
  it("a window whose file values are all nodata, between covered windows of its row, has no tile decoded", async () => {
    const { source, reads } = samplesSource({ ...GRID, bandCount: 4, nodata: null, float: false, alpha: 3 }, (k, c) => (k === 3 ? (c % 5 ? 255 : 0) : 9), { width: 256, height: 256, bytes: 256 * 256 * 4 });
    const file = fakeLabelSource(GRID, (c) => (c >= 256 && c < 512 ? 255 : 1), 255).source; // window column 256 all nodata
    expect(typeof await importLabels(source, file, null)).not.toBe("string");
    expect(reads.length).toBeGreaterThan(0);
    for (const t of reads) for (let x = t.x0; x < t.x0 + t.width; x += 256) expect(x >= 256 && x < 512, `tile at ${x},${t.y0}`).toBe(false);
  });
});
