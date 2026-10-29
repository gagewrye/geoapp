import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dequantize, type AefEntry } from "../../../src/core/aef";
import { AefFileError, openAefFile } from "../../../src/io/aefLocal";
import { openFile } from "../../../src/io/geotiffSource";
import { NodeFileReader } from "../helpers/fileReader";
import { firstDiff } from "../helpers/floats";
import { geotiffBuffer } from "../helpers/sources";

// "Open AlphaEarth file" (spec 002 Scope, criterion 15): a local COG through the dequantizing
// reader, presented on its north-up grid, which is the Aoi.
const F = "tests/fixtures/aef";
const chip = JSON.parse(readFileSync(`${F}/ref_chip.json`, "utf8")) as { x0: number; y1: number; width: number };
const entries = JSON.parse(readFileSync(`${F}/aef-index/2021/32617.json`, "utf8")) as AefEntry[];
const refBuf = readFileSync(`${F}/ref_chip.i8`);
const ref = new Int8Array(refBuf.buffer, refBuf.byteOffset, refBuf.length); // [64][128][128] north-up
const N = chip.width;
const blob = (name: string) => new Blob([readFileSync(`${F}/cogs/${name}`)]);

/** dequantize of the reference chip's band b over chip columns [c0, c0 + w) and rows [r0, r0 + h). */
function want(b: number, c0: number, r0: number, w: number, h: number): Float32Array {
  const q = new Int8Array(w * h);
  for (let r = 0; r < h; r++) q.set(ref.subarray(b * N * N + (r0 + r) * N + c0, b * N * N + (r0 + r) * N + c0 + w), r * w);
  const out = new Float32Array(w * h);
  dequantize(q, out);
  return out;
}

beforeEach(() => vi.stubGlobal("FileReader", NodeFileReader));
afterEach(() => vi.unstubAllGlobals());

describe("openAefFile", () => {
  it.each(entries.map((e) => [e.path, e] as const))("%s: no requests, north-up Aoi at its index bounds, windows equal dequantize of the chip", async (path, e) => {
    const fetch = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetch);
    const { source, aoi } = await openAefFile(blob(path));
    const w = (e.x1 - e.x0) / 10, h = (e.y1 - e.y0) / 10;
    expect(aoi).toEqual({ epsg: 32617, gt: [e.x0, 10, 0, e.y1, 0, -10], width: w, height: h });
    expect(source.meta).toMatchObject({ width: w, height: h, bandCount: 64, gt: aoi.gt, epsg: 32617, nodata: null });
    const c0 = (e.x0 - chip.x0) / 10, r0 = (chip.y1 - e.y1) / 10;
    // a window not starting at row 0, so a bottom-up file must map rows, not only flip them
    const t = await source.readWindow(5, 3, w - 5, h - 3);
    expect(t).toMatchObject({ x0: 5, y0: 3, width: w - 5, height: h - 3, nodata: null });
    for (let b = 0; b < 64; b++) expect(firstDiff(t.bands[b]!, want(b, c0 + 5, r0 + 3, w - 5, h - 3)), `band ${b}`).toBe(-1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a raster that is not AlphaEarth-encoded", async () => {
    const buf = geotiffBuffer(10, 10, 3, () => 1, { epsg: 32617, gt: [500000, 10, 0, 2800000, 0, -10] });
    await expect(openAefFile(new Blob([buf]))).rejects.toBeInstanceOf(AefFileError);
  });
});

describe("openFile flags AlphaEarth files", () => {
  it("true for an AEF COG, false for other rasters", async () => {
    expect((await openFile(blob(entries[0]!.path))).aef).toBe(true);
    const buf = geotiffBuffer(10, 10, 3, () => 1, { epsg: 32617, gt: [500000, 10, 0, 2800000, 0, -10] });
    expect((await openFile(new Blob([buf]))).aef).toBe(false);
  });
});
