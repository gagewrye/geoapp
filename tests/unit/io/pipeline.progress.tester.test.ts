import { describe, expect, it } from "vitest";
import { buildPreview } from "../../../src/io/pipeline";
import { fakeSource } from "../helpers/sources";

// Spec 019 criteria 1-3, edge cases: single and partial windows, read bounds, NaN nodata, aborts at the ends.

const value = (b: number, c: number, r: number) => (b === 0 ? c % 251 : b === 1 ? r % 13 : (c + r) % 5);
const isAbort = (e: unknown) => (e as Error).name === "AbortError";

describe("progress edge cases (criterion 1)", () => {
  it("a single-window raster reports (1, 1) once", async () => {
    const { source, reads } = fakeSource({ width: 100, height: 100 }, value);
    const calls: [number, number][] = [];
    await buildPreview(source, 64, { onProgress: (d, t) => calls.push([d, t]) });
    expect(reads).toHaveLength(1);
    expect(calls).toEqual([[1, 1]]);
  });

  it("partial edge windows count: 513 x 257 is 3 x 2 windows, each within the raster and at most 256 x 256", async () => {
    const { source, reads } = fakeSource({ width: 513, height: 257 }, value);
    const calls: [number, number][] = [];
    await buildPreview(source, 128, { onProgress: (d, t) => calls.push([d, t]) });
    expect(reads).toHaveLength(6);
    expect(calls).toEqual([1, 2, 3, 4, 5, 6].map((d) => [d, 6]));
    for (const r of reads) {
      expect(r.width).toBeLessThanOrEqual(256);
      expect(r.height).toBeLessThanOrEqual(256);
      expect(r.x0 + r.width).toBeLessThanOrEqual(513);
      expect(r.y0 + r.height).toBeLessThanOrEqual(257);
    }
    expect(reads.some((r) => r.width === 1) && reads.some((r) => r.height === 1)).toBe(true);
  });

  it("a large raster (5000 x 3000) reads only 256 x 256 windows, each once, and total = reads", async () => {
    const { source, reads } = fakeSource({ width: 5000, height: 3000, bandCount: 1 }, () => 1);
    let last: [number, number] = [0, 0];
    let calls = 0;
    await buildPreview(source, 256, { onProgress: (d, t) => { calls++; last = [d, t]; } });
    expect(reads).toHaveLength(Math.ceil(5000 / 256) * Math.ceil(3000 / 256));
    expect(calls).toBe(reads.length);
    expect(last).toEqual([reads.length, reads.length]);
    expect(Math.max(...reads.map((r) => r.width * r.height))).toBeLessThanOrEqual(256 * 256);
    expect(new Set(reads.map((r) => `${r.x0},${r.y0}`)).size).toBe(reads.length);
  });
});

describe("options don't change the preview (criterion 2)", () => {
  it.each([
    ["1 band, NaN nodata", { width: 600, height: 300, bandCount: 1, nodata: Number.NaN }, (_b: number, c: number) => (c < 100 ? Number.NaN : c % 9)],
    ["2 bands (grey)", { width: 300, height: 600, bandCount: 2 }, value],
    ["4 bands", { width: 513, height: 257, bandCount: 4 }, value],
  ] as const)("%s", async (_n, meta, f) => {
    const a = await buildPreview(fakeSource(meta, f).source, 200);
    const b = await buildPreview(fakeSource(meta, f).source, 200, { onProgress: () => {}, signal: new AbortController().signal });
    expect([b.width, b.height, b.corners]).toEqual([a.width, a.height, a.corners]);
    expect(Buffer.from(b.rgba).equals(Buffer.from(a.rgba))).toBe(true);
  });
});

describe("abort edge cases (criterion 3)", () => {
  it("an abort during the last window's read rejects with AbortError, with no further reads", async () => {
    const { source, reads } = fakeSource({ width: 600, height: 600 }, value); // 9 windows
    const ac = new AbortController();
    const read = source.readWindow.bind(source);
    source.readWindow = async (...a) => { const t = await read(...a); if (reads.length === 9) ac.abort(); return t; };
    await expect(buildPreview(source, 128, { signal: ac.signal })).rejects.toSatisfy(isAbort);
    expect(reads).toHaveLength(9);
  });

  it("an abort from the last progress call (before the warp) rejects with AbortError", async () => {
    const { source } = fakeSource({ width: 600, height: 600 }, value);
    const ac = new AbortController();
    await expect(buildPreview(source, 128, { signal: ac.signal, onProgress: (d, t) => { if (d === t) ac.abort(); } })).rejects.toSatisfy(isAbort);
  });

  it("an abort with a string reason still rejects with a DOMException named AbortError", async () => {
    const { source, reads } = fakeSource({ width: 600, height: 600 }, value);
    const ac = new AbortController();
    const read = source.readWindow.bind(source);
    source.readWindow = async (...a) => { const t = await read(...a); if (reads.length === 2) ac.abort("newer open"); return t; };
    const err = await buildPreview(source, 128, { signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(reads).toHaveLength(2);
  });

  it("an abort after the preview resolved changes nothing", async () => {
    const { source } = fakeSource({ width: 300, height: 300 }, value);
    const ac = new AbortController();
    const p = await buildPreview(source, 128, { signal: ac.signal });
    ac.abort();
    expect(p.width).toBeGreaterThan(0);
  });

  it("a read error is passed through as is, not turned into an AbortError", async () => {
    const { source } = fakeSource({ width: 600, height: 600 }, value);
    const boom = new Error("disk gone");
    source.readWindow = async () => { throw boom; };
    await expect(buildPreview(source, 128, { signal: new AbortController().signal })).rejects.toBe(boom);
  });
});
