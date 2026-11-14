import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { maskReadFailed, openLabelFile, openLabelTiff } from "../../../src/io/labelFile";
import { uint8Tiff } from "../helpers/tiffFixtures";

// Specs 023 F4 and 025 together (merge e567d75): the 4 cached 256-row chunks are read through the blob source,
// a cached row reads no file bytes, and a failed chunk read reaches maskReadFailed without being cached.

const GEO = { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] as [number, number, number, number, number, number] };
const W = 600, H = 1400;
const value = (c: number, r: number) => (c * 3 + r) % 7;
const buf = () => uint8Tiff([{ width: W, height: H, bands: 1, value: (_k, c, r) => value(c, r), layout: { rows: 1 } }], GEO);

/** A Blob counting the arrayBuffer() calls of its slices, which fail while `failing` is set. */
function blobOf(data: ArrayBuffer) {
  const blob = new Blob([data]);
  const state = { reads: 0, failing: false };
  const slice = blob.slice.bind(blob);
  blob.slice = (start?: number, end?: number, type?: string) => {
    const part = slice(start, end, type), read = part.arrayBuffer.bind(part);
    part.arrayBuffer = () => { state.reads++; return state.failing ? Promise.reject(new DOMException("changed", "NotReadableError")) : read(); };
    return part;
  };
  return { blob, state };
}
const win = (x0: number, y0: number) => ({ x0, y0, width: Math.min(256, W - x0), height: Math.min(256, H - y0) });

describe("label file: row chunks through the blob source", () => {
  it("windows of 4 cached rows read no file bytes again; a 5th row drops the least recent; bytes equal fromArrayBuffer", async () => {
    const data = buf();
    const { blob, state } = blobOf(data);
    const src = await openLabelFile(blob), ref = await openLabelTiff(await fromArrayBuffer(data));
    for (const y0 of [0, 256, 512, 768]) for (const x0 of [0, 256, 512]) {
      expect(Buffer.from(await src.read(win(x0, y0))).equals(Buffer.from(await ref.read(win(x0, y0)))), `${x0},${y0}`).toBe(true);
    }
    let n = state.reads;
    for (const y0 of [768, 0, 512, 256]) for (const x0 of [0, 256, 512]) await src.read(win(x0, y0));
    expect(state.reads).toBe(n);
    await src.read(win(0, 1280)); // the partial last row: a 5th row, dropping row 768
    expect(state.reads).toBeGreaterThan(n);
    n = state.reads;
    await src.read(win(256, 256));
    expect(state.reads).toBe(n);
    await src.read(win(256, 768));
    expect(state.reads).toBeGreaterThan(n);
  });

  it("a chunk read that fails reaches maskReadFailed and is not cached: the next read of that row reads the file and decodes", async () => {
    const data = buf();
    const { blob, state } = blobOf(data);
    const src = await openLabelFile(blob), ref = await openLabelTiff(await fromArrayBuffer(data));
    state.failing = true;
    const e = await src.read(win(256, 512)).catch((x: unknown) => x);
    expect(maskReadFailed(e)).toBe(true);
    state.failing = false;
    const n = state.reads;
    const got = await src.read(win(256, 512));
    expect(state.reads).toBeGreaterThan(n);
    expect(Buffer.from(got).equals(Buffer.from(await ref.read(win(256, 512))))).toBe(true);
  });
});
