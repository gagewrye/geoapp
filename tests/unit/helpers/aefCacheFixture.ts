import { fromArrayBuffer } from "geotiff";
import { vi } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { PLANE_BYTES } from "../../../src/io/aefCache";
import { aefTiff, pattern } from "./aefTiff";
import { FakeDir } from "./fakeOpfs";

// Shared by the per-band OPFS cache tester tests (spec 002 Cache rule, criteria 12 and 17).
export const BASE = "https://aef.test/v1/annual/";
export const OX = 500000, OY = 2800000;
export const MSG = "Couldn't download embeddings from aef.test.";

export type Cog = { entry: AefEntry; bytes: Uint8Array; gx0: number; gy0: number; width: number; height: number };
export function cog(name: string, gx0: number, gy0: number, width: number, height: number, bottomUp: boolean): Cog {
  const x0 = OX + 10 * gx0, y1 = OY - 10 * gy0;
  const bytes = aefTiff({ width, height, x0, y1, tile: 64, bottomUp, value: (b, r, c) => pattern(b, gx0 + c, gy0 + r) });
  return { entry: { year: 2021, epsg: 32617, path: `2021/17N/${name}.tiff`, x0, y0: y1 - 10 * height, x1: x0 + 10 * width, y1 }, bytes, gx0, gy0, width, height };
}
// two COGs with a 20 px gap between them (no data there); the AOI is 3 x 2 windows with clipped east and south edges
export const west = cog("west", 0, 0, 300, 420, true), east = cog("east", 320, 0, 400, 420, false);
export const COGS = [west, east];
export const AOI_BOX = [10, 15, 600, 400] as const; // global pixel x, y, width, height
export const aoi: Aoi = { epsg: 32617, gt: [OX + 10 * AOI_BOX[0], 10, 0, OY - 10 * AOI_BOX[1], 0, -10], width: AOI_BOX[2], height: AOI_BOX[3] };
export const files = new Map(COGS.map((c) => [BASE + c.entry.path, c.bytes]));

/** Expected Int8 plane of band b for window i: the pattern where a COG covers it, else -128 (gap, padding). */
export function want(b: number, i: number, a: Aoi = aoi, box: readonly number[] = AOI_BOX): Int8Array {
  const win = tileWindows(a.width, a.height)[i]!;
  const out = new Int8Array(PLANE_BYTES).fill(-128);
  for (let r = 0; r < win.height; r++) for (let c = 0; c < win.width; c++) {
    const gx = box[0]! + win.x0 + c, gy = box[1]! + win.y0 + r;
    if (COGS.some((k) => gx >= k.gx0 && gx < k.gx0 + k.width && gy >= k.gy0 && gy < k.gy0 + k.height)) out[r * 256 + c] = pattern(b, gx, gy);
  }
  return out;
}

/** Every writable the fake OPFS hands out, with its file name and how it ended. */
export function trackWritables() {
  const ws: { file: string; state: "open" | "closed" | "aborted" }[] = [];
  let peakOpen = 0;
  const get = FakeDir.prototype.getFileHandle;
  vi.spyOn(FakeDir.prototype, "getFileHandle").mockImplementation(async function (this: FakeDir, name: string, o?: { create?: boolean }) {
    const h = await get.call(this, name, o);
    const create = h.createWritable;
    return {
      ...h,
      async createWritable() {
        const w = await create();
        const t = { file: name, state: "open" as "open" | "closed" | "aborted" };
        ws.push(t);
        peakOpen = Math.max(peakOpen, ws.filter((x) => x.state === "open").length);
        return {
          write: w.write,
          async close() { await w.close(); t.state = "closed"; },
          async abort() { await w.abort(); t.state = "aborted"; },
        };
      },
    };
  });
  return { ws, peakOpen: () => peakOpen };
}

/** Byte offsets of the tiles of band b in a COG. */
export async function bandTiles(c: Cog, b: number): Promise<Set<number>> {
  const img = await (await fromArrayBuffer(c.bytes.slice().buffer)).getImage();
  const offsets = Array.from(await img.fileDirectory.loadValue("TileOffsets") as ArrayLike<number>, Number);
  const per = offsets.length / AEF_BANDS;
  return new Set(offsets.slice(b * per, (b + 1) * per));
}
