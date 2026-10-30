import { describe, expect, it } from "vitest";
import { fromArrayBuffer, type GeoTIFFImage } from "geotiff";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { rawEligible, rawOffsets, rawWindow } from "../../../src/io/rawReader";
import { rawTiff, type RawImage } from "../helpers/rawTiffs";

// Spec 028 criteria 1 (raw reads byte-equal to geotiff) and 2 (which files read raw; the rest decode as before).

const W = 700, H = 530;
/** Seeded, so a failure repeats. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const ints = (k: number, c: number, r: number) => (k * 977 + c * 31 + r * 17) % 65536;
const VALUES = {
  u8: (k: number, c: number, r: number) => ints(k, c, r) & 255,
  u16: ints,
  i16: (k: number, c: number, r: number) => ints(k, c, r) - 32768,
  f32: (k: number, c: number, r: number) => Math.fround(ints(k, c, r) / 7 - 1000.25),
};
const bytes = (a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Asserts arrays of the same type and bytes. */
function sameArrays(got: ArrayLike<number>[], want: ArrayLike<number>[]) {
  expect(got).toHaveLength(want.length);
  got.forEach((g, i) => {
    expect(g.constructor).toBe(want[i]!.constructor);
    // Buffer.equals: toEqual on arrays of a million bytes is too slow
    expect(Buffer.from(bytes(g as Uint8Array)).equals(bytes(want[i] as Uint8Array)), `array ${i}`).toBe(true);
  });
}

/** Random windows and sample lists, plus windows at the right and bottom edges and a whole-image read. */
function windows(width: number, height: number, bands: number, seed: number) {
  const r = rng(seed), n = (k: number) => 1 + Math.floor(r() * k);
  const out: { win: [number, number, number, number]; samples: number[] }[] = [];
  const pick = () => { const all = [...Array(bands).keys()].filter(() => r() < 0.6); return all.length ? all.sort(() => r() - 0.5) : [bands - 1]; };
  for (let i = 0; i < 12; i++) {
    const w = n(Math.min(width, 300)), h = n(Math.min(height, 300));
    const x0 = Math.floor(r() * (width - w + 1)), y0 = Math.floor(r() * (height - h + 1));
    out.push({ win: [x0, y0, w, h], samples: pick() });
  }
  out.push({ win: [width - 37, 5, 37, 40], samples: pick() }, { win: [3, height - 29, 50, 29], samples: pick() },
    { win: [width - 256, height - 256, 256, 256], samples: pick() }, { win: [0, 0, width, height], samples: [...Array(bands).keys()] });
  return out;
}

async function checkImage(buf: ArrayBuffer, index: number, seed: number) {
  const tiff = await fromArrayBuffer(buf);
  const image: GeoTIFFImage = await tiff.getImage(index);
  expect(rawEligible(image)).toBe(true);
  const offsets = await rawOffsets(image);
  const [width, height, bands] = [image.getWidth(), image.getHeight(), image.getSamplesPerPixel()];
  for (const { win: [x0, y0, w, h], samples } of windows(width, height, bands, seed)) {
    const want = (await image.readRasters({ window: [x0, y0, x0 + w, y0 + h], samples: [...samples] })) as unknown as ArrayLike<number>[];
    const got = await rawWindow(image, tiff.source, offsets, x0, y0, w, h, samples);
    sameArrays(got, Array.from(want));
  }
}

const LAYOUTS: [string, RawImage["layout"]][] = [["1-row strips", { rows: 1 }], ["16-row strips", { rows: 16 }], ["256² tiles", { tile: [256, 256] }]];
const FORMATS: [string, Pick<RawImage, "bits" | "format" | "value" | "bands">][] = [
  ["uint8 RGBA", { bits: 8, format: 1, value: VALUES.u8, bands: 4 }],
  ["uint16 little-endian", { bits: 16, format: 1, value: VALUES.u16, bands: 3 }],
  ["int16", { bits: 16, format: 2, value: VALUES.i16, bands: 2 }],
  ["float32", { bits: 32, format: 3, value: VALUES.f32, bands: 2 }],
];

describe("rawWindow, byte-equal to geotiff readRasters (criterion 1)", () => {
  LAYOUTS.forEach(([lname, layout], li) => FORMATS.forEach(([fname, f], fi) => {
    it(`${fname}, ${lname}: full image and overview`, async () => {
      const full: RawImage = { width: W, height: H, layout, ...f };
      const ov: RawImage = { ...full, width: 350, height: 265, subfile: 1, value: (k, c, r) => f.value(k, 2 * c, 2 * r) };
      const buf = rawTiff([full, ov]);
      await checkImage(buf, 0, 100 * li + fi);
      await checkImage(buf, 1, 100 * li + fi + 50);
    });
  }));

  it("big-endian uint8 reads raw too: byte order doesn't matter for 1-byte samples", async () => {
    await checkImage(rawTiff([{ width: W, height: H, layout: { rows: 16 }, bits: 8, value: VALUES.u8, bands: 3 }], false), 0, 7);
  });

  it("copies across yields once 8 ms have passed (fake clock: 1 ms per row), still byte-equal, and stops on an abort", async () => {
    const tiff = await fromArrayBuffer(rawTiff([{ width: W, height: H, layout: { rows: 1 }, bits: 16, value: VALUES.u16, bands: 3 }]));
    const image = await tiff.getImage(0), offsets = await rawOffsets(image);
    let t = 0, yields = 0;
    const budget = { now: () => t++, yieldTask: async () => { yields++; } };
    const got = await rawWindow(image, tiff.source, offsets, 10, 20, 300, 100, [2, 0], undefined, budget);
    expect(yields).toBeGreaterThanOrEqual(100 / 9 - 1); // a yield about every 8 rows
    sameArrays(got, Array.from((await image.readRasters({ window: [10, 20, 310, 120], samples: [2, 0] })) as unknown as ArrayLike<number>[]));
    const ac = new AbortController();
    const aborting = { now: () => t++, yieldTask: async () => { ac.abort(); } };
    await expect(rawWindow(image, tiff.source, offsets, 0, 0, 50, 100, [0], ac.signal, aborting)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("openGeoTiff's readSamples reads raw, byte-equal, and rejects an aborted read", async () => {
    const buf = rawTiff([{ width: W, height: H, layout: { rows: 1 }, bits: 8, value: VALUES.u8, bands: 4 }]);
    const tiff = await fromArrayBuffer(buf);
    const src = await openGeoTiff(tiff);
    expect(src.raw).toEqual([0]);
    const image = await tiff.getImage(0);
    const want = await image.readRasters({ window: [650, 500, 700, 530], samples: [2, 3] });
    sameArrays(await src.readSamples(0, 650, 500, 50, 30, [2, 3]), Array.from(want as unknown as ArrayLike<number>[]));
    const ac = new AbortController();
    ac.abort();
    await expect(src.readSamples(0, 0, 0, 10, 10, [0], ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("files that still decode through geotiff (criterion 2)", () => {
  const base: RawImage = { width: 300, height: 200, layout: { rows: 16 }, bits: 8, value: VALUES.u8, bands: 3 };
  const cases: [string, RawImage, boolean?][] = [
    ["LZW", { ...base, compression: 5 }],
    ["Deflate", { ...base, compression: 8 }],
    ["Predictor 2 with Deflate", { ...base, compression: 8, predictor: 2 }],
    ["Predictor 2 uncompressed", { ...base, predictor: 2 }],
    ["planar 2", { ...base, planar: 2 }],
    ["planar 2 tiles", { ...base, planar: 2, layout: { tile: [128, 128] } }],
    ["12-bit", { ...base, bits: 12, value: (k, c, r) => ints(k, c, r) & 4095 }],
    ["big-endian uint16", { ...base, bits: 16, value: VALUES.u16 }, false],
  ];
  for (const [name, im, le] of cases) {
    it(`${name}: not raw, and readSamples equals geotiff's readRasters`, async () => {
      const tiff = await fromArrayBuffer(rawTiff([im], le ?? true));
      const image = await tiff.getImage(0);
      expect(rawEligible(image)).toBe(false);
      const src = await openGeoTiff(tiff);
      expect(src.raw).toEqual([]);
      for (const { win: [x0, y0, w, h], samples } of windows(300, 200, 3, 3)) {
        const want = await image.readRasters({ window: [x0, y0, x0 + w, y0 + h], samples: [...samples] });
        sameArrays(await src.readSamples(0, x0, y0, w, h, samples), Array.from(want as unknown as ArrayLike<number>[]));
      }
    });
  }
});
