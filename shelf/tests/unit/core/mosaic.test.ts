import { describe, expect, it } from "vitest";
import type { Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { overlapWindow, pasteBand, placeCog, tileLastWindow, type Placement } from "../../../src/core/mosaic";

const aoi: Aoi = { epsg: 32617, gt: [1000, 10, 0, 5000, 0, -10], width: 300, height: 300 };

describe("placeCog", () => {
  it("places a north-up COG by its top-left corner", () => {
    expect(placeCog(aoi, [1200, 10, 0, 4900, 0, -10], 50, 40)).toEqual({ col: 20, row: 10, width: 50, height: 40, bottomUp: false });
  });

  it("places a bottom-up COG by its north-up top-left corner", () => {
    // south edge at 4500, 40 rows -> north edge 4900
    expect(placeCog(aoi, [1200, 10, 0, 4500, 0, 10], 50, 40)).toEqual({ col: 20, row: 10, width: 50, height: 40, bottomUp: true });
  });

  it("allows COGs that start outside the AOI", () => {
    expect(placeCog(aoi, [-80000, 10, 0, 90000, 0, -10], 8192, 8192)).toMatchObject({ col: -8100, row: -8500 });
  });

  it.each([
    ["origin 5 m off in x", [1205, 10, 0, 4900, 0, -10]],
    ["origin 5 m off in y", [1200, 10, 0, 4895, 0, -10]],
    ["20 m pixels", [1200, 20, 0, 4900, 0, -20]],
    ["rotated", [1200, 10, 1, 4900, 0, -10]],
  ] as const)("refuses a COG with %s", (_name, gt) => {
    expect(placeCog(aoi, [...gt], 50, 40)).toBeNull();
  });
});

describe("overlapWindow", () => {
  const win = { x0: 256, y0: 0, width: 44, height: 256 };
  it("returns the file window and destination offset of the covered part", () => {
    const p = { col: 250, row: 100, width: 20, height: 30, bottomUp: false };
    expect(overlapWindow(p, win)).toEqual({ src: [6, 0, 20, 30], dx: 0, dy: 100, w: 14, h: 30, bottomUp: false });
  });

  it("counts file rows from the south for a bottom-up COG", () => {
    // AOI rows 200..256 are north-up COG rows 100..156, i.e. file rows 300-156..300-100
    const p = { col: 200, row: 100, width: 100, height: 300, bottomUp: true };
    expect(overlapWindow(p, win)).toEqual({ src: [56, 144, 100, 300], dx: 0, dy: 100, w: 44, h: 156, bottomUp: true });
  });

  it("returns null when the COG misses the window or only touches it", () => {
    expect(overlapWindow({ col: 0, row: 0, width: 256, height: 256, bottomUp: false }, win)).toBeNull();
    expect(overlapWindow({ col: 300, row: 0, width: 10, height: 10, bottomUp: false }, win)).toBeNull();
  });
});

describe("pasteBand", () => {
  it("copies rows into the window, flipping a bottom-up source", () => {
    const src = Int8Array.from([1, 2, 3, 4, 5, 6]); // 3 wide, 2 rows, row 0 = south
    const top = new Int8Array(16).fill(-128);
    pasteBand(top, 4, src, { src: [0, 0, 3, 2], dx: 1, dy: 1, w: 3, h: 2, bottomUp: true });
    expect(Array.from(top)).toEqual([-128, -128, -128, -128, -128, 4, 5, 6, -128, 1, 2, 3, -128, -128, -128, -128]);
    const down = new Int8Array(16).fill(-128);
    pasteBand(down, 4, src, { src: [0, 0, 3, 2], dx: 0, dy: 2, w: 3, h: 2, bottomUp: false });
    expect(Array.from(down.subarray(8))).toEqual([1, 2, 3, -128, 4, 5, 6, -128]);
  });

  it("fills only no-data pixels, so an earlier valid value stays and a source -128 never erases one", () => {
    const dst = Int8Array.from([5, -128, -128, 7]); // 4 wide, 1 row
    pasteBand(dst, 4, Int8Array.from([1, 2, -128, -128]), { src: [0, 0, 4, 1], dx: 0, dy: 0, w: 4, h: 1, bottomUp: false });
    expect(Array.from(dst)).toEqual([5, 2, -128, 7]);
  });
});

describe("tileLastWindow", () => {
  /** Brute force: for each tile, every row-major window whose overlap with the COG touches it. */
  function readers(p: Placement, tw: number, th: number, aoiW: number, aoiH: number): Map<number, number[]> {
    const across = Math.ceil(p.width / tw);
    const out = new Map<number, number[]>();
    tileWindows(aoiW, aoiH).forEach((win, i) => {
      const o = overlapWindow(p, win);
      if (!o) return;
      const [c0, r0, c1, r1] = o.src;
      for (let ty = Math.floor(r0 / th); ty < Math.ceil(r1 / th); ty++) for (let tx = Math.floor(c0 / tw); tx < Math.ceil(c1 / tw); tx++) {
        const t = ty * across + tx;
        out.set(t, [...(out.get(t) ?? []), i]);
      }
    });
    return out;
  }
  const layouts: [string, Placement, number, number, number, number][] = [
    ["bottom-up, 288 px tiles straddling window rows", { col: -20, row: -30, width: 576, height: 576, bottomUp: true }, 288, 288, 500, 520],
    ["top-down, partial last tiles", { col: 37, row: 11, width: 700, height: 650, bottomUp: false }, 320, 320, 900, 700],
    ["real-like: 1024 px tiles, 2048 px AOI at an odd offset", { col: -1023, row: -517, width: 8192, height: 8192, bottomUp: true }, 1024, 1024, 2048, 2048],
    ["COG inside one window", { col: 10, row: 10, width: 50, height: 40, bottomUp: false }, 32, 32, 300, 300],
  ];

  it.each(layouts)("%s: matches the last window that reads each tile", (_name, p, tw, th, w, h) => {
    const last = tileLastWindow(p, tw, th, w, h);
    const want = new Map([...readers(p, tw, th, w, h)].map(([t, ws]) => [t, Math.max(...ws)]));
    expect(new Map([...last].sort((a, b) => a[0] - b[0]))).toEqual(new Map([...want].sort((a, b) => a[0] - b[0])));
  });

  const realLike: typeof layouts = [
    ...layouts.slice(0, 3),
    ["1024 px tiles, AOI on tile corners", { col: -2048, row: -1024, width: 8192, height: 8192, bottomUp: false }, 1024, 1024, 2048, 2048],
    ["1024 px tiles, AOI past the COG's south-east corner", { col: -7000, row: -7500, width: 8192, height: 8192, bottomUp: true }, 1024, 1024, 2048, 2048],
  ];
  // the download's memory bound: per band and COG, at most (tile columns across the AOI + 2) tiles
  it.each(realLike)("%s: tiles kept from first to last read never exceed the tile columns across plus 2", (_name, p, tw, th, w, h) => {
    const uses = readers(p, tw, th, w, h);
    const across = new Set([...uses.keys()].map((t) => t % Math.ceil(p.width / tw))).size;
    let peak = 0;
    for (let i = 0; i < tileWindows(w, h).length; i++) {
      peak = Math.max(peak, [...uses.values()].filter((ws) => ws[0]! <= i && i <= ws[ws.length - 1]!).length);
    }
    expect(peak).toBeLessThanOrEqual(across + 2);
  });
});
