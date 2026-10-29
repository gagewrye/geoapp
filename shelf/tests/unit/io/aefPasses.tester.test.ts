import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS } from "../../../src/core/aef";
import { BAND_GROUP } from "../../../src/io/aefDownload";
import { colsAcross, eachByteOnce, groups, pixelsRight, run } from "../helpers/aefPassProbe";

// Tester re-verification of the band-group redesign (spec 002 Cache, review issue 1):
// passes never refetch a band-separate tile, interleaved and mixed AOIs fall back to one pass,
// and the per-COG bound on held compressed tiles and decoded tiles per read holds structurally.

afterEach(() => vi.restoreAllMocks());

describe("band-group passes (tester, spec 002 Cache)", () => {
  // Generous timeout: synthetic multi-tile 64-band COGs are slow under full-suite parallel load.
  it("two band-separate COGs: 8 passes, every read fetches only its pass's bands, no tile is fetched twice or after release", async () => {
    const box: [number, number, number, number] = [40, 30, 600, 400];
    const r = await run([
      { name: "w", gx0: 0, gy0: 0, width: 330, height: 500, tile: 96, bottomUp: true },
      { name: "e", gx0: 330, gy0: 0, width: 400, height: 500, tile: 128 },
    ], box);
    expect(new Set(r.probe.reads.map((x) => x.samples.join(",")))).toEqual(new Set(groups(BAND_GROUP)));
    // passes in band order, windows row-major inside each
    const passOrder = r.probe.reads.map((x) => x.samples[0]! / BAND_GROUP);
    expect(passOrder).toEqual([...passOrder].sort((a, b) => a - b));
    for (const read of r.probe.reads) for (const t of read.tiles) expect(read.samples).toContain(r.cogOf(t.src).band.get(t.offset));
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    for (const [, h] of r.probe.held) expect(h.size).toBe(0);
    await pixelsRight(r, box);
  }, 30_000);

  // Generous timeout: synthetic multi-tile 64-band COGs are slow under full-suite parallel load.
  it("mixed AOI (one pixel-interleaved COG, one band-separate): one pass of 64 bands, no tile fetched twice, pixels right", async () => {
    const box: [number, number, number, number] = [20, 10, 500, 300];
    const r = await run([
      { name: "i", gx0: 0, gy0: 0, width: 260, height: 320, tile: 64, interleaved: true },
      { name: "s", gx0: 260, gy0: 0, width: 300, height: 320, tile: 80, bottomUp: true },
    ], box);
    expect(new Set(r.probe.reads.map((x) => x.samples.join(",")))).toEqual(new Set(groups(AEF_BANDS)));
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    for (const [, h] of r.probe.held) expect(h.size).toBe(0);
    await pixelsRight(r, box, 17);
  }, 30_000);

  // Generous timeout: synthetic multi-tile 64-band COGs are slow under full-suite parallel load.
  it("an interleaved-only AOI over several tile rows: one pass, each 64-band tile fetched once and held at most C + 2", async () => {
    const box: [number, number, number, number] = [5, 7, 700, 600];
    const r = await run([{ name: "i2", gx0: 0, gy0: 0, width: 720, height: 640, tile: 288, interleaved: true, bottomUp: true }], box);
    expect(new Set(r.probe.reads.map((x) => x.samples.length))).toEqual(new Set([AEF_BANDS]));
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    for (const [s, n] of r.probe.peak) expect(n).toBeLessThanOrEqual(colsAcross(r.cogOf(s).s, box[0], box[2]) + 2);
    for (const read of r.probe.reads) expect(read.tiles.length).toBeLessThanOrEqual(4);
    await pixelsRight(r, box, 31);
  }, 30_000);
});
