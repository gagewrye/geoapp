import { describe, expect, it } from "vitest";
import type { AefEntry, Aoi } from "../../../src/core/aef";
import { memoryStore } from "../../../src/io/aefCache";
import { AefCrsError, fetchEntries } from "../../../src/io/aefDownload";
import { AefDownloadError } from "../../../src/io/rangeGet";
import { aefTiff, memFetch, pattern } from "../helpers/aefTiff";

// Tester checks of review issue 12: a COG in another CRS is refused with AefCrsError, which names
// both CRSs, comes before the grid check, and is not reported as a download failure.
const BASE = "https://aef.test/v1/annual/";
const OX = 500000, OY = 2800000;
const aoi: Aoi = { epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: 100, height: 100 };

function cog(name: string, o: { epsg?: number; dx?: number }) {
  const x0 = OX + (o.dx ?? 0);
  const bytes = aefTiff({ width: 100, height: 100, x0, y1: OY, epsg: o.epsg, value: (b, r, c) => pattern(b, c, r) });
  const entry: AefEntry = { year: 2021, epsg: 32617, path: `2021/17N/${name}.tiff`, x0, y0: OY - 1000, x1: x0 + 1000, y1: OY };
  return { entry, files: new Map([[BASE + entry.path, bytes]]) };
}

describe("AefCrsError (tester, review issue 12)", () => {
  it.each([
    ["another hemisphere", 32717, "EPSG:32717"],
    ["a geographic CRS code", 4326, "EPSG:4326"],
  ])("a COG in %s is refused naming both CRSs, the cache discarded, nothing written", async (_n, epsg, crs) => {
    const c = cog(`crs-${epsg}`, { epsg });
    const store = memoryStore();
    const err = await fetchEntries(aoi, [c.entry], store, { fetch: memFetch(c.files).fetch, base: BASE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AefCrsError);
    expect(err).not.toBeInstanceOf(AefDownloadError);
    expect((err as Error).message).toBe(`AlphaEarth file ${c.entry.path} is in ${crs}, not the area's EPSG:32617.`);
    expect([store.writes, store.discarded]).toEqual([0, true]);
  });

  it("a COG both off the 10 m grid and in another zone gets the CRS message, not the grid one", async () => {
    const c = cog("both", { epsg: 32618, dx: 5 });
    await expect(fetchEntries(aoi, [c.entry], memoryStore(), { fetch: memFetch(c.files).fetch, base: BASE }))
      .rejects.toThrow(`is in EPSG:32618, not the area's EPSG:32617.`);
  });

  it("a COG in the AOI's CRS but 5 m off still gets the grid message", async () => {
    const c = cog("off", { dx: 5 });
    await expect(fetchEntries(aoi, [c.entry], memoryStore(), { fetch: memFetch(c.files).fetch, base: BASE }))
      .rejects.toThrow(`AlphaEarth file ${c.entry.path} is not on the area's 10 m grid.`);
  });
});
