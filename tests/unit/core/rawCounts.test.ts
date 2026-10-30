import { describe, expect, it } from "vitest";
import { countRaw, finishImport, maskVals, rawCounts } from "../../../src/core/rawCounts";
import { compactMask } from "../../../src/core/validMask";

// Spec 024 scope 2: one pass counts raw values; finishImport derives what spec 004's labelling pass gave.

/** A seeded pseudo-random generator, so failures repeat. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

describe("raw counts", () => {
  it("maskVals sets nodata pixels to -1 and leaves the rest", () => {
    const vals = Int16Array.from([3, 0, -1, 7, 255, 9, 9, 9, 4]);
    const bits = new Uint8Array(2); bits[0] = 0b00010011; // pixels 0, 1, 4
    maskVals(compactMask(bits, 9), vals);
    expect(Array.from(vals)).toEqual([-1, -1, -1, 7, -1, 9, 9, 9, 4]);
    const all = Int16Array.from([1, 2]); maskVals("all", all); expect(Array.from(all)).toEqual([1, 2]);
    const none = Int16Array.from([1, 2]); maskVals("none", none); expect(Array.from(none)).toEqual([-1, -1]);
  });

  it("finishImport gives the count, labelled windows, class count and preview that applying the LUT window by window gives", () => {
    const next = rng(7);
    for (let trial = 0; trial < 20; trial++) {
      const windows = 1 + Math.floor(next() * 6), n = 50;
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) if (next() < 0.1) lut[v] = 1 + Math.floor(next() * 5);
      const counts = rawCounts(windows);
      const preview = new Uint16Array(windows * 10);
      let count = 0;
      const labelled: number[] = [], classes = new Set<number>(), want = new Uint8Array(preview.length);
      for (let wi = 0; wi < windows; wi++) {
        const vals = Int16Array.from({ length: n }, () => (next() < 0.2 ? -1 : Math.floor(next() * (next() < 0.5 ? 20 : 256))));
        countRaw(vals, counts, wi);
        let any = false;
        for (const v of vals) if (v >= 0 && lut[v]) { any = true; count++; classes.add(lut[v]!); }
        if (any) labelled.push(wi);
        for (let k = 0; k < 10; k++) { const v = vals[k * 5]!; preview[wi * 10 + k] = v + 1; want[wi * 10 + k] = any && v >= 0 ? lut[v]! : 0; }
      }
      const r = finishImport(counts, lut, preview);
      expect(r.count).toBe(count);
      expect(r.labelled).toEqual(labelled);
      expect(r.classCount).toBe(classes.size);
      expect(Array.from(r.preview)).toEqual(Array.from(want));
    }
  });

  it("countRaw counts kept values (>= 0) in hist and in its window's present bits only", () => {
    const counts = rawCounts(2);
    countRaw(Int16Array.from([5, 5, -1, 200]), counts, 1);
    expect(counts.hist[5]).toBe(2);
    expect(counts.hist[200]).toBe(1);
    expect(counts.present[32 + (5 >> 3)]! & (1 << (5 & 7))).toBeTruthy();
    expect(counts.present.slice(0, 32).every((b) => b === 0)).toBe(true);
  });
});
