import { readFileSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { northUpAffine } from "../../../src/core/geotags";
import { openGeoTiff } from "../../../src/io/geotiffSource";

const DIR = "tests/fixtures/aef/real";
const NAME = "xm0lu3s74sdjecpf8-0000000000-0000008192";

function buffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** The .vrt's north-up GeoTransform, in GDAL order. */
function vrtGeoTransform(): number[] {
  const m = /<GeoTransform>([^<]+)<\/GeoTransform>/.exec(readFileSync(`${DIR}/${NAME}.vrt`, "utf8"));
  return m![1]!.split(",").map(Number);
}

describe("bottom-up real COG header (criterion 6)", () => {
  it("derives the geotransform and orientation from the file's own tags, matching the .vrt", async () => {
    // Only the first 256 KiB exist, so any pixel read would fail.
    const tiff = await fromArrayBuffer(buffer(`${DIR}/${NAME}.head.tiff`));
    const src = await openGeoTiff(tiff);
    const { gt, width, height, epsg, bandCount } = src.meta;
    expect([width, height, bandCount, epsg]).toEqual([8192, 8192, 64, 32617]);
    expect(gt[5]).toBeGreaterThan(0); // bottom-up: row 0 is the southern edge
    expect(northUpAffine(gt, height)).toEqual(vrtGeoTransform());
    // geotiff.js getResolution negates y, which would place this file 82 km off
    expect((await tiff.getImage(0)).getResolution()[1]).toBe(-gt[5]);
  });
});
