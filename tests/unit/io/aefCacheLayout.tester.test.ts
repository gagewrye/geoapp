import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { opfsStore, PLANE_BYTES } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { memFetch, pattern } from "../helpers/aefTiff";
import { aoi, BASE, COGS, files, OX, OY, trackWritables, want, west } from "../helpers/aefCacheFixture";
import { fakeOpfs } from "../helpers/fakeOpfs";

// Tester re-verification of the per-band OPFS cache layout (spec 002 Cache rule, criterion 17):
// each plane written once at the right offset, edge padding -128, at most one band group of
// files open at a time.
afterEach(() => vi.restoreAllMocks());

describe("per-band OPFS layout (tester, criterion 17)", () => {
  it("two COGs with a gap, clipped edge windows: 64 files written once each, plane i at i x 64 KiB, padding and gap -128", async () => {
    const tw = trackWritables();
    const { handle, locks, root, log } = fakeOpfs();
    const store = await opfsStore("aef-cache", handle, { locks });
    await fetchEntries(aoi, COGS.map((c) => c.entry), store, { fetch: memFetch(files).fetch, base: BASE });
    const n = tileWindows(aoi.width, aoi.height).length;
    expect(n).toBe(6);

    // one writable per band file, all closed, never more than one band group open at once
    expect(tw.ws.map((w) => w.file).sort()).toEqual(Array.from({ length: AEF_BANDS }, (_, b) => `b${b}.i8`).sort());
    expect(tw.ws.every((w) => w.state === "closed")).toBe(true);
    expect(tw.peakOpen()).toBe(BAND_GROUP);

    const dir = await root.getDirectoryHandle("aef-cache");
    expect(dir.entries.size).toBe(AEF_BANDS);
    for (let b = 0; b < AEF_BANDS; b++) {
      expect(log.filter((l) => l.file === `b${b}.i8`).map((l) => [l.at, l.bytes]), `b${b}`).toEqual(Array.from({ length: n }, (_, i) => [i * PLANE_BYTES, PLANE_BYTES]));
      const data = new Int8Array(await (await (await dir.getFileHandle(`b${b}.i8`)).getFile()).arrayBuffer());
      expect(data.length).toBe(n * PLANE_BYTES);
      for (let i = 0; i < n; i++) {
        const got = data.subarray(i * PLANE_BYTES, (i + 1) * PLANE_BYTES), exp = want(b, i);
        expect(got.findIndex((v, k) => v !== exp[k]), `band ${b} window ${i}`).toBe(-1);
      }
    }
    // read(i) returns the same 64 planes
    for (let i = 0; i < n; i++) {
      const planes = await store.read(i);
      expect(planes).toHaveLength(AEF_BANDS);
      for (const b of [0, 9, 63]) { const exp = want(b, i); expect(planes[b]!.findIndex((v, k) => v !== exp[k])).toBe(-1); }
    }
    await expect(store.read(n)).rejects.toThrow(`no window ${n}`);
  });

  it("a 1 x 1 px AOI is one window: 64 files of exactly 64 KiB, one valid pixel, the rest -128", async () => {
    const { handle, locks, root } = fakeOpfs();
    const store = await opfsStore("aef-cache", handle, { locks });
    const a: Aoi = { ...aoi, gt: [OX + 10 * 100, 10, 0, OY - 10 * 50, 0, -10], width: 1, height: 1 };
    await fetchEntries(a, [west.entry], store, { fetch: memFetch(files).fetch, base: BASE });
    const dir = await root.getDirectoryHandle("aef-cache");
    for (const b of [0, 63]) {
      const data = new Int8Array(await (await (await dir.getFileHandle(`b${b}.i8`)).getFile()).arrayBuffer());
      expect(data.length).toBe(PLANE_BYTES);
      expect(data[0]).toBe(pattern(b, 100, 50));
      expect(data.subarray(1).every((v) => v === -128)).toBe(true);
    }
  });
});
