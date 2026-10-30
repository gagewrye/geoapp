import { describe, expect, it } from "vitest";
import { bandOrder, compactMask, maskLabels, MASK_BYTES, MaskStore, validAt } from "../../../src/core/validMask";

// Spec 023 criteria 4 (compactMask) and 5 (the store: a whole raster kept, LRU past MASK_BYTES, no array for uniform windows), and bandOrder.

describe("compactMask (criterion 4)", () => {
  it("returns \"all\" or \"none\" for uniform bits, else the bits", () => {
    expect(compactMask(new Uint8Array(8192), 65536)).toBe("all");
    expect(compactMask(new Uint8Array(8192).fill(255), 65536)).toBe("none");
    // 10 pixels: bits past n don't count
    expect(compactMask(Uint8Array.from([255, 3]), 10)).toBe("none");
    expect(compactMask(Uint8Array.from([255, 0b111]), 10)).toBe("none");
    expect(compactMask(Uint8Array.from([0, 0b100]), 10)).toBe("all");
    const mixed = Uint8Array.from([1, 0]);
    expect(compactMask(mixed, 10)).toBe(mixed);
  });

  it("validAt and maskLabels read all three forms", () => {
    expect([validAt("all", 3), validAt("none", 3), validAt(Uint8Array.from([0b1000]), 3), validAt(Uint8Array.from([0b1000]), 2)]).toEqual([true, false, false, true]);
    const l = Uint8Array.from([1, 2, 3, 4]);
    maskLabels(Uint8Array.from([0b0101]), l);
    expect([...l]).toEqual([0, 2, 0, 4]);
    maskLabels("all", l);
    expect([...l]).toEqual([0, 2, 0, 4]);
    maskLabels("none", l);
    expect([...l]).toEqual([0, 0, 0, 0]);
  });
});

describe("MaskStore (criterion 5)", () => {
  it("keeps every window of an 11,000 x 11,000 raster: 1,849 mixed windows are about 15 MiB", () => {
    const s = new MaskStore();
    let n = 0;
    for (let y = 0; y < 11000; y += 256) for (let x = 0; x < 11000; x += 256) { s.set(`${x},${y}`, new Uint8Array(8192)); n++; }
    expect(n).toBe(1849);
    expect(s.size).toBe(1849);
    expect(s.bytes).toBe(1849 * 8192);
    expect(s.bytes).toBeLessThan(16 * 2 ** 20);
  });

  it("past MASK_BYTES drops the least recently used arrays first, never uniform windows, which hold no array", () => {
    const s = new MaskStore(3 * 8192);
    s.set("a", "all");
    s.set("n", "none");
    for (const k of ["0", "1", "2"]) s.set(k, new Uint8Array(8192));
    expect(s.get("0")).toBeInstanceOf(Uint8Array); // now most recent
    s.set("3", new Uint8Array(8192));
    expect([...s.keys()].sort()).toEqual(["0", "2", "3", "a", "n"]);
    expect(s.bytes).toBe(3 * 8192);
    expect([s.get("a"), s.get("n")]).toEqual(["all", "none"]);
    expect(MASK_BYTES).toBe(256 * 2 ** 20);
  });
});

describe("bandOrder", () => {
  it("centre first, then alternately below and above, within range", () => {
    expect(bandOrder(5, 2)).toEqual([2, 3, 1, 4, 0]);
    expect(bandOrder(5, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(bandOrder(4, 3)).toEqual([3, 2, 1, 0]);
    expect(bandOrder(3, 9)).toEqual([2, 1, 0]);
    expect(bandOrder(0, 0)).toEqual([]);
  });
});
