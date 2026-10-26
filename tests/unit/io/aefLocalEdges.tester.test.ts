import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS } from "../../../src/core/aef";
import { TILE_SIZE } from "../../../src/core/types";
import { AefFileError, openAefFile } from "../../../src/io/aefLocal";
import { buildAefPreview } from "../../../src/io/aefPreview";
import { openFile } from "../../../src/io/geotiffSource";
import { aefTiff, pattern } from "../helpers/aefTiff";
import { NodeFileReader } from "../helpers/fileReader";
import { fakeSource } from "../helpers/sources";

// Tester edges for "Open AlphaEarth file" / "Open GeoTIFF" (spec 002 Scope, criterion 15):
// what counts as an AEF file, partial edge windows of bottom-up files, and read-window bounds.
const OX = 500000, OY = 2800000;
const deq = (v: number) => Math.fround((v * Math.abs(v)) / (127.5 * 127.5));

/** Rewrite the values of one IFD tag in place (first IFD, little-endian, as aefTiff writes). */
function patchTag(bytes: Uint8Array, tag: number, f: (dv: DataView, at: number, count: number, type: number) => void): Uint8Array {
  const out = bytes.slice();
  const dv = new DataView(out.buffer);
  const n = dv.getUint16(8, true);
  const size: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
  for (let i = 0; i < n; i++) {
    const p = 10 + 12 * i;
    if (dv.getUint16(p, true) !== tag) continue;
    const type = dv.getUint16(p + 2, true), count = dv.getUint32(p + 4, true);
    const at = count * size[type]! <= 4 ? p + 8 : dv.getUint32(p + 8, true);
    f(dv, at, count, type);
    return out;
  }
  throw new Error(`tag ${tag} not found`);
}
const setNodata = (b: Uint8Array, s: string) => patchTag(b, 42113, (dv, at, count) => {
  for (let i = 0; i < count; i++) dv.setUint8(at + i, i < s.length ? s.charCodeAt(i) : 0);
});
const setShorts = (b: Uint8Array, tag: number, v: number) => patchTag(b, tag, (dv, at, count) => {
  for (let i = 0; i < count; i++) dv.setUint16(at + 2 * i, v, true);
});

const base = (o: { bands?: number; width?: number; height?: number; bottomUp?: boolean; tile?: number } = {}) => aefTiff({
  width: o.width ?? 40, height: o.height ?? 30, bands: o.bands ?? 64, tile: o.tile ?? 16, x0: OX, y1: OY, bottomUp: o.bottomUp,
  value: (b, r, c) => pattern(b, c, r),
});
const blob = (b: Uint8Array) => new Blob([b.slice().buffer]);

beforeEach(() => vi.stubGlobal("FileReader", NodeFileReader));
afterEach(() => vi.unstubAllGlobals());

describe("what is an AlphaEarth file", () => {
  it("the unpatched synthetic file is one (control)", async () => {
    expect((await openFile(blob(base()))).aef).toBe(true);
    await expect(openAefFile(blob(base()))).resolves.toBeTruthy();
  });

  const refused: [string, () => Uint8Array][] = [
    ["63 Int8 bands, nodata -128", () => base({ bands: 63 })],
    ["65 Int8 bands, nodata -128", () => base({ bands: 65 })],
    ["64 Int8 bands, nodata -127", () => setNodata(base(), "-127")],
    ["64 Int8 bands, nodata 0", () => setNodata(base(), "0")],
    ["64 unsigned 8-bit bands, nodata -128", () => setShorts(base(), 339, 1)],
    ["64 Int8 bands with no nodata tag", () => setNodata(base(), "")],
  ];
  it.each(refused)("%s: Open AlphaEarth file refuses it, Open GeoTIFF does not flag it", async (_n, make) => {
    const b = make();
    await expect(openAefFile(blob(b))).rejects.toBeInstanceOf(AefFileError);
    expect((await openFile(blob(b))).aef).toBe(false);
  });

});

describe("local AlphaEarth file: partial edge windows and tiny files", () => {
  it.each([false, true])("bottomUp=%s: every grid window, including partial edge ones, equals the pattern north-up", async (bottomUp) => {
    const W = 300, H = 270;
    const { source, aoi } = await openAefFile(blob(base({ width: W, height: H, bottomUp, tile: 64 })));
    expect(aoi).toEqual({ epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: W, height: H });
    for (const [x0, y0, w, h] of [[0, 0, 256, 256], [256, 0, 44, 256], [0, 256, 256, 14], [256, 256, 44, 14], [299, 269, 1, 1]] as const) {
      const t = await source.readWindow(x0, y0, w, h);
      expect(t).toMatchObject({ x0, y0, width: w, height: h });
      expect(t.bands).toHaveLength(AEF_BANDS);
      for (const b of [0, 1, 16, 9, 63]) for (let r = 0; r < h; r += 7) for (let c = 0; c < w; c += 5) {
        expect(t.bands[b]![r * w + c], `b${b} r${y0 + r} c${x0 + c}`).toBe(deq(pattern(b, x0 + c, y0 + r)));
      }
    }
  });

  it("a 1 x 1 px AlphaEarth file opens and builds a preview", async () => {
    const { source, aoi } = await openAefFile(blob(base({ width: 1, height: 1, bottomUp: true })));
    expect(aoi).toMatchObject({ width: 1, height: 1 });
    const p = await buildAefPreview(source, 1024);
    expect(p.width * p.height).toBeGreaterThan(0);
  });
});

describe("memory bound (structural): previewing AlphaEarth data reads only grid windows", () => {
  it("a 3000 x 2100 px, 64-band source is read in windows of at most 256 x 256, each window once", async () => {
    const { source, reads } = fakeSource({ width: 3000, height: 2100, bandCount: 64, nodata: null }, (b, c, r) => ((b + c + r) % 60 - 30) / 100);
    await buildAefPreview(source, 1024);
    expect(reads.length).toBe(Math.ceil(3000 / TILE_SIZE) * Math.ceil(2100 / TILE_SIZE));
    for (const w of reads) {
      expect(w.width).toBeLessThanOrEqual(TILE_SIZE);
      expect(w.height).toBeLessThanOrEqual(TILE_SIZE);
      expect(w.x0 % TILE_SIZE).toBe(0);
      expect(w.y0 % TILE_SIZE).toBe(0);
    }
    expect(new Set(reads.map((w) => `${w.x0},${w.y0}`)).size).toBe(reads.length);
  });
});
