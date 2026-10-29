import { afterEach, describe, expect, it, vi } from "vitest";
import type { Aoi } from "../../../src/core/aef";
import { memoryStore } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
import { RangeSource } from "../../../src/io/rangeSource";
import { pattern, memFetch } from "../helpers/aefTiff";
import { BASE, deq, eachByteOnce, make, OX, OY, type Spec } from "../helpers/aefPassProbe";

afterEach(() => vi.restoreAllMocks());

describe("sparse tiles (tester, GDAL SPARSE_OK)", () => {
  /** Set TileByteCounts[i] to 0 in a little-endian classic TIFF, as GDAL writes an empty tile. */
  function sparsify(bytes: Uint8Array, tiles: number[]) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true);
    for (let e = 0; e < n; e++) {
      const p = ifd + 2 + 12 * e;
      if (dv.getUint16(p, true) !== 325) continue;
      const at = dv.getUint32(p + 8, true);
      for (const i of tiles) dv.setUint32(at + 4 * i, 0, true);
    }
  }

  it("a 0-byte tile in bands 0 and 40 is never requested and reads as NaN; its neighbours are unaffected", async () => {
    const s: Spec = { name: "sp", gx0: 0, gy0: 0, width: 256, height: 256, tile: 128 }; // 4 tiles per band
    const c = await make(s);
    const bytes = c.bytes.slice();
    sparsify(bytes, [0 * 4 + 3, 40 * 4 + 3]); // south-east tile of bands 0 and 40
    const { fetch, log } = memFetch(new Map([[BASE + c.entry.path, bytes]]));
    const fetchSpy = vi.spyOn(RangeSource.prototype, "fetch");
    const aoi: Aoi = { epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: 256, height: 256 };
    const src = await fetchEntries(aoi, [c.entry], memoryStore(), { fetch, base: BASE });
    const t = await src.readWindow(0, 0, 256, 256);
    expect(t.bands[0]![200 * 256 + 200]).toBeNaN();
    expect(t.bands[40]![200 * 256 + 200]).toBeNaN();
    expect(t.bands[1]![200 * 256 + 200]).toBe(deq(pattern(1, 200, 200)));
    expect(t.bands[0]![10 * 256 + 200]).toBe(deq(pattern(0, 200, 10)));
    // geotiff.js asks the source for no slice at a sparse tile, and for each other tile exactly
    const tileOffset = (b: number, i: number) => [...c.band.entries()].filter(([, k]) => k === b).map(([o]) => o).sort((x, y) => x - y)[i]!;
    const asked = new Set(fetchSpy.mock.calls.flatMap(([sl]) => (sl as { offset: number }[]).map((x) => x.offset)));
    for (const o of [tileOffset(0, 3), tileOffset(40, 3)]) expect(asked.has(o)).toBe(false);
    for (const o of [tileOffset(0, 2), tileOffset(40, 2), tileOffset(41, 3)]) expect(asked.has(o)).toBe(true);
    eachByteOnce(new Map([[BASE + c.entry.path, bytes]]), log);
  });
});
