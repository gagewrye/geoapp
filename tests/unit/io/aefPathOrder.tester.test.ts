import { describe, expect, it } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { memoryStore } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
import { aefTiff, memFetch } from "../helpers/aefTiff";

// Tester re-verification of F1: valid beats no data; among valid values the COG whose path
// sorts first wins; the result is the same for every index order.
const BASE = "https://aef.test/v1/annual/";
const OX = 500000, OY = 2800000;
const deq = (v: number) => (v === -128 ? NaN : Math.fround((v * Math.abs(v)) / (127.5 * 127.5)));

/** A 120x100 COG at the AOI origin: value `v + band % 3` except -128 where `hole(r, c)`. */
function cog(path: string, v: number, hole: (r: number, c: number) => boolean, bottomUp: boolean) {
  const bytes = aefTiff({ width: 120, height: 100, x0: OX, y1: OY, tile: 64, bottomUp, value: (b, r, c) => (hole(r, c) ? -128 : v + (b % 3)) });
  const entry: AefEntry = { year: 2021, epsg: 32617, path, x0: OX, y0: OY - 1000, x1: OX + 1200, y1: OY };
  return { entry, bytes, v, hole };
}
// Sorted by path: "a.tiff" < "a0.tiff" < "b.tiff" ('.' is 0x2E, '0' is 0x30).
const A = cog("2021/17N/a.tiff", 10, (r, c) => c < 40 || (r > 80 && c > 100), true);
const A0 = cog("2021/17N/a0.tiff", 50, (r) => r < 30 || r > 80, false);
const B = cog("2021/17N/b.tiff", 90, (r, c) => r > 90 && c > 100, true);
const byPath = [A, A0, B];
const aoi: Aoi = { epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: 120, height: 100 };
const files = new Map(byPath.map((k) => [BASE + k.entry.path, k.bytes]));
const want = (b: number, r: number, c: number) => {
  const k = byPath.find((x) => !x.hole(r, c));
  return k ? deq(k.v + (b % 3)) : NaN;
};
const perms = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

describe("mosaic precedence by path (tester, F1)", () => {
  it.each(perms([0, 1, 2]).map((p) => [p.join(","), p] as const))("index order %s gives the path-order result pixel for pixel", async (_n, order) => {
    const src = await fetchEntries(aoi, order.map((i) => byPath[i]!.entry), memoryStore(), { fetch: memFetch(files).fetch, base: BASE });
    let nan = 0;
    for (const w of tileWindows(aoi.width, aoi.height)) {
      const t = await src.readWindow(w.x0, w.y0, w.width, w.height);
      for (let b = 0; b < AEF_BANDS; b += 9) for (let r = 0; r < w.height; r++) for (let c = 0; c < w.width; c++) {
        const got = t.bands[b]![r * w.width + c]!, exp = want(b, w.y0 + r, w.x0 + c);
        if (Number.isNaN(exp)) { expect(got).toBeNaN(); nan++; } else if (got !== exp) expect({ b, r, c, got }).toEqual({ b, r, c, got: exp });
      }
    }
    expect(nan).toBeGreaterThan(0); // the corner no COG covers stays NaN
  });

  it("the same entry listed twice changes nothing", async () => {
    const src = await fetchEntries(aoi, [B.entry, A.entry, B.entry, A0.entry], memoryStore(), { fetch: memFetch(files).fetch, base: BASE });
    const t = await src.readWindow(0, 0, 120, 100);
    expect(t.bands[0]![50 * 120 + 50]).toBe(deq(10)); // A valid there
    expect(t.bands[0]![50 * 120 + 10]).toBe(deq(50)); // A hole, A0 valid
    expect(t.bands[0]![10 * 120 + 10]).toBe(deq(90)); // A and A0 holes, B valid
  });
});
