import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const JPG = "src/map/basemap.jpg";
const NOTICE = "src/map/basemap.NOTICE.md";

/** Width, height and marker of the first SOFn segment of a JPEG. */
function sof(b: Uint8Array): { marker: number; width: number; height: number } {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("not a JPEG (no SOI)");
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Error(`no marker at ${p}`);
    const m = b[p + 1]!;
    const len = (b[p + 2]! << 8) | b[p + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { marker: m, height: (b[p + 5]! << 8) | b[p + 6]!, width: (b[p + 7]! << 8) | b[p + 8]! };
    p += 2 + len;
  }
  throw new Error("no SOF marker");
}

describe("bundled basemap asset (spec 012 criterion 1)", () => {
  it("is a 2048x2048 baseline JPEG of at most 1 MiB", () => {
    const b = new Uint8Array(readFileSync(JPG));
    const s = sof(b);
    expect(s.marker).toBe(0xc0); // SOF0: baseline
    expect([s.width, s.height]).toEqual([2048, 2048]);
    expect(statSync(JPG).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it("has a NOTICE naming the source, version, licence and both commands", () => {
    const n = readFileSync(NOTICE, "utf8");
    expect(n).toContain("NE1_50M_SR_W");
    expect(n).toContain("3.2.0");
    expect(n.toLowerCase()).toContain("public domain");
    expect(n).toContain("gdalwarp -s_srs EPSG:4326 -t_srs EPSG:3857 -te -20037508.34 -20037508.34 20037508.34 20037508.34 -ts 2048 2048 -r average");
    expect(n).toContain("gdal_translate -of JPEG -co QUALITY=85");
  });
});
