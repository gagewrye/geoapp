import { describe, expect, it } from "vitest";
import { openFile } from "../../../src/io/geotiffSource";
import { rawTiff, type RawImage } from "../helpers/rawTiffs";

// Spec 024 with spec 028: a held band's capped geotiff reads make no file call of their own.
const value = (k: number, c: number, r: number) => (k * 37 + c * 3 + r * 7) & 255;

function counted(buf: ArrayBuffer) {
  const blob = new Blob([buf]);
  let calls = 0;
  const slice = blob.slice.bind(blob);
  blob.slice = (start?: number, end?: number, type?: string) => { calls++; return slice(start, end, type); };
  return { blob, calls: () => calls };
}

const same = (a: ArrayLike<number>[], b: ArrayLike<number>[]) => a.length === b.length && a.every((x, i) => Buffer.from((x as Uint8Array).buffer).equals(Buffer.from((b[i] as Uint8Array).buffer)));

describe("geotiffSource hold", () => {
  const base: RawImage = { width: 700, height: 500, bands: 4, bits: 8, value, layout: { tile: [128, 128] }, compression: 8 };
  for (const [name, im] of [["Deflate tiles", base], ["Deflate tiles, planar 2", { ...base, planar: 2 as const }], ["LZW 16-row strips", { ...base, compression: 5 as const, layout: { rows: 16 } }]] as const) {
    it(`${name}: reads of held windows make no file call and equal unheld reads; after release they read the file`, async () => {
      const { blob, calls } = counted(rawTiff([im]));
      const src = await openFile(blob);
      expect(src.raw).toEqual([]);
      const band = [{ x0: 0, y0: 256, width: 256, height: 128 }, { x0: 256, y0: 256, width: 444, height: 128 }];
      const want = await Promise.all(band.map((w) => src.readSamples(0, w.x0, w.y0, w.width, w.height, [1, 3])));
      const before = calls();
      const release = await src.hold!(0, band, [1, 3]);
      expect(calls() - before).toBe(1);
      for (const [i, w] of band.entries()) expect(same(await src.readSamples(0, w.x0, w.y0, w.width, w.height, [1, 3]), want[i]!)).toBe(true);
      expect(calls() - before).toBe(1);
      release();
      await src.readSamples(0, 0, 256, 10, 10, [1]);
      expect(calls() - before).toBe(2);
    });
  }

  it("holds nothing for an uncompressed (raw) image", async () => {
    const { blob, calls } = counted(rawTiff([{ ...base, compression: 1 }]));
    const src = await openFile(blob);
    expect(src.raw).toEqual([0]);
    const before = calls();
    (await src.hold!(0, [{ x0: 0, y0: 0, width: 700, height: 128 }], [0]))();
    expect(calls()).toBe(before);
  });
});
