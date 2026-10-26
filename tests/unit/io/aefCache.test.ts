import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows, type Window } from "../../../src/core/grid";
import { opfsStore, PLANE_BYTES } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
import { fakeOpfs } from "../helpers/fakeOpfs";
import { firstDiff } from "../helpers/floats";
import { rangeFetch } from "../helpers/rangeFetch";

// Criterion 17: one OPFS file per band, 64 KiB window planes in row-major order, each written once.
const F = "tests/fixtures/aef";
const json = <T>(p: string): T => JSON.parse(readFileSync(`${F}/${p}`, "utf8")) as T;
const chip = json<{ epsg: number; x0: number; y1: number; width: number; height: number }>("ref_chip.json");
const entries = json<AefEntry[]>("aef-index/2021/32617.json");
const refBuf = readFileSync(`${F}/ref_chip.i8`);
const ref = new Int8Array(refBuf.buffer, refBuf.byteOffset, refBuf.length); // [64][128][128] north-up
const N = chip.width;

/** AOI with the chip's north-west corner at AOI pixel (col, row). */
const aoiAround = (col: number, row: number, width: number, height: number): Aoi =>
  ({ epsg: chip.epsg, gt: [chip.x0 - 10 * col, 10, 0, chip.y1 + 10 * row, 0, -10], width, height });

/** The reference chip's band-k plane for window `win` of an AOI with the chip at (col, row); -128 off the chip or window. */
function refPlane(k: number, win: Window, col: number, row: number): Int8Array {
  const out = new Int8Array(PLANE_BYTES).fill(-128);
  const { x0, y0 } = win;
  for (let r = 0; r < win.height; r++) for (let c = 0; c < win.width; c++) {
    const cr = y0 + r - row, cc = x0 + c - col;
    if (cr >= 0 && cr < N && cc >= 0 && cc < N) out[r * 256 + c] = ref[k * N * N + cr * N + cc]!;
  }
  return out;
}

describe("cache layout (criterion 17)", () => {
  it.each([
    ["the fixture (a) AOI", 0, 0, N, N],
    ["an AOI of 2x2 windows with the chip across all four and padded edge windows", 192, 200, 320, 300],
  ])("%s: 64 band files of (windows x 64 KiB), each plane written once, reads equal the reference chip", async (_n, col, row, w, h) => {
    const { handle, root, log } = fakeOpfs();
    const store = await opfsStore("aef-cache", handle);
    const aoi = aoiAround(col, row, w, h);
    await fetchEntries(aoi, entries, store, { fetch: rangeFetch().fetch });
    const windows = tileWindows(w, h);

    const dir = await root.getDirectoryHandle("aef-cache");
    const files = [...dir.entries.keys()].sort();
    expect(files).toEqual(Array.from({ length: AEF_BANDS }, (_, b) => `b${b}.i8`).sort());
    for (const name of files) {
      expect((await (await dir.getFileHandle(name)).getFile()).size, name).toBe(windows.length * PLANE_BYTES);
      // appended in row-major window order: plane i at byte i x 64 KiB, once each
      expect(log.filter((l) => l.file === name).map((l) => [l.at, l.bytes]), name)
        .toEqual(windows.map((_, i) => [i * PLANE_BYTES, PLANE_BYTES]));
    }

    for (const [i, win] of windows.entries()) {
      const planes = await store.read(i);
      expect(planes).toHaveLength(AEF_BANDS);
      planes.forEach((p, k) => expect(firstDiff(p, refPlane(k, win, col, row)), `window ${i} band ${k}`).toBe(-1));
    }
  });

  it("a failed download aborts the open band files and deletes the cache", async () => {
    const { handle, root } = fakeOpfs();
    const store = await opfsStore("aef-cache", handle);
    // fail on the east COGs' pixels, while the first pass's band files are open
    const fault = (url: string, range: [number, number] | null) => (url.endsWith("fixture-ne-topdown.tiff") && range && range[0] >= 8192 ? "network" as const : undefined);
    await expect(fetchEntries(aoiAround(192, 0, 320, N), entries, store, { fetch: rangeFetch(fault).fetch, blockSize: 4096 }))
      .rejects.toThrow("Couldn't download embeddings from");
    expect(root.entries.has("aef-cache")).toBe(false);
  });

  it("opening the store drops an earlier AOI's cache", async () => {
    const { handle, root } = fakeOpfs();
    const old = await opfsStore("aef-cache", handle);
    await fetchEntries(aoiAround(0, 0, N, N), entries, old, { fetch: rangeFetch().fetch });
    // a cache left by an earlier page load: on disk, but no live store holds it
    await old.discard();
    const left = await root.getDirectoryHandle("aef-cache", { create: true });
    await (await (await left.getFileHandle("b0.i8", { create: true })).createWritable()).close();
    await opfsStore("aef-cache", handle);
    expect((await root.getDirectoryHandle("aef-cache")).entries.size).toBe(0);
  });
});

describe("one live store per folder (tester F1)", () => {
  it("refuses a second store on a folder while the first is live, and leaves the first's cache intact", async () => {
    const { handle, root } = fakeOpfs();
    const first = await opfsStore("aef-cache", handle);
    await fetchEntries(aoiAround(0, 0, N, N), entries, first, { fetch: rangeFetch().fetch });
    await expect(opfsStore("aef-cache", handle)).rejects.toThrow("The AlphaEarth cache is already in use.");
    expect((await root.getDirectoryHandle("aef-cache")).entries.size).toBe(AEF_BANDS);
    expect(await first.read(0)).toHaveLength(AEF_BANDS);
  });

  it("two opens started together: exactly one gets the folder", async () => {
    const { handle } = fakeOpfs();
    const r = await Promise.allSettled([opfsStore("aef-cache", handle), opfsStore("aef-cache", handle)]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("another folder, or another root, is not blocked", async () => {
    const a = fakeOpfs(), b = fakeOpfs();
    await opfsStore("aef-cache", a.handle);
    await expect(opfsStore("other", a.handle)).resolves.toBeDefined();
    await expect(opfsStore("aef-cache", b.handle)).resolves.toBeDefined();
  });

  it("after discard the folder opens again, and the discarded store neither writes, reads nor deletes the new one", async () => {
    const { handle, root } = fakeOpfs();
    const old = await opfsStore("aef-cache", handle);
    await old.discard();
    const fresh = await opfsStore("aef-cache", handle);
    const w = await fresh.band(0);
    await w.append(new Int8Array(PLANE_BYTES));
    await w.close();
    await expect(old.band(1)).rejects.toThrow("discarded");
    await expect(old.read(0)).rejects.toThrow("discarded");
    await old.discard(); // a no-op: the folder now belongs to the fresh store
    const dir = await root.getDirectoryHandle("aef-cache");
    expect((await (await dir.getFileHandle("b0.i8")).getFile()).size).toBe(PLANE_BYTES);
  });

  it("a failed open releases the folder", async () => {
    const { handle, root } = fakeOpfs();
    const get = root.getDirectoryHandle.bind(root);
    let fail = true;
    root.getDirectoryHandle = async (n, o) => { if (fail) throw new DOMException("denied", "SecurityError"); return get(n, o); };
    await expect(opfsStore("aef-cache", handle)).rejects.toThrow("denied");
    fail = false;
    await expect(opfsStore("aef-cache", handle)).resolves.toBeDefined();
  });
});
