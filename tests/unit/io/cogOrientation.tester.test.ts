import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Aoi } from "../../../src/core/aef";
import { northUpAffine } from "../../../src/core/geotags";
import { overlapWindow, placeCog } from "../../../src/core/mosaic";
import { openRemoteCog } from "../../../src/io/aefRemote";
import { memFetch } from "../helpers/aefTiff";

// Tester tests for spec 002 criterion 6: the real header opened the way downloads open it.
const DIR = "tests/fixtures/aef/real";
const NAME = "xm0lu3s74sdjecpf8-0000000000-0000008192";
const URL_ = "https://aef.test/v1/annual/2021/17N/" + NAME + ".tiff";
const head = new Uint8Array(readFileSync(`${DIR}/${NAME}.head.tiff`));
const vrt = readFileSync(`${DIR}/${NAME}.vrt`, "utf8");
const vrtGt = /<GeoTransform>([^<]+)<\/GeoTransform>/.exec(vrt)![1]!.split(",").map(Number);

describe("real bottom-up COG through the download path (tester, criterion 6)", () => {
  it("openRemoteCog reads only header bytes and derives the .vrt's north-up geotransform", async () => {
    const { fetch, log } = memFetch(new Map([[URL_, head]]));
    const cog = await openRemoteCog(URL_, fetch);
    expect(cog.meta.gt[5]).toBe(10); // bottom-up as stored
    expect(northUpAffine(cog.meta.gt, cog.meta.height)).toEqual(vrtGt);
    expect([cog.meta.width, cog.meta.height, cog.meta.bandCount, cog.meta.epsg]).toEqual([8192, 8192, 64, 32617]);
    expect(log.length).toBeGreaterThan(0);
    for (const l of log) expect(l.range![0]).toBeLessThan(head.length); // header only, no pixel tiles
  });

  it("an AOI at the file's north-west corner maps to its last file rows, flipped", async () => {
    const cog = await openRemoteCog(URL_, memFetch(new Map([[URL_, head]])).fetch);
    const aoi: Aoi = { epsg: 32617, gt: [vrtGt[0]!, 10, 0, vrtGt[3]!, 0, -10], width: 300, height: 300 };
    const at = placeCog(aoi, cog.meta.gt, cog.meta.width, cog.meta.height);
    expect(at).toEqual({ col: 0, row: 0, width: 8192, height: 8192, bottomUp: true });
    expect(overlapWindow(at!, { x0: 0, y0: 0, width: 256, height: 256 })!.src).toEqual([0, 8192 - 256, 256, 8192]);
    expect(overlapWindow(at!, { x0: 256, y0: 256, width: 44, height: 44 })!.src).toEqual([256, 8192 - 300, 300, 8192 - 256]);
  });

  it("the .vrt names band 1 A00, so the preview's 1-based 2, 17, 10 are A01, A16, A09", () => {
    const names = [...vrt.matchAll(/<Description>(A\d\d)<\/Description>/g)].map((m) => m[1]);
    expect(names).toHaveLength(64);
    expect([names[1], names[16], names[9]]).toEqual(["A01", "A16", "A09"]);
  });
});
