import { describe, expect, it } from "vitest";
import { SAM_SIDE } from "../../../src/core/smart";
import { readSamInput } from "../../../src/io/samImagery";
import { samplesSource } from "../helpers/sources";

// Spec 046 scope 4: the window is read as 256x256 readSamples calls of the displayed bands, one at a time, mapped
// with toRgba and the preview's ranges, so nodata is black (0 in the tensor).
describe("readSamInput", () => {
  const block = { width: 256, height: 256, bytes: 256 * 256 * 12 };
  const value = (b: number, c: number, r: number) => (c === 700 && r === 600 ? -1 : b === 0 ? 255 : 0);

  it("reads 256x256 windows one at a time and maps them as displayed", async () => {
    const { source, reads } = samplesSource({ width: 1500, height: 1200, nodata: -1 }, value, block);
    let inFlight = 0, most = 0;
    const read = source.readSamples.bind(source);
    source.readSamples = async (...a) => { most = Math.max(most, ++inFlight); await new Promise((r) => setTimeout(r, 0)); inFlight--; return read(...a); };
    const w = { x0: 256, y0: 0, width: 1024, height: 1024 };
    const t = await readSamInput(source, w, [[0, 255], [0, 255], [0, 255]], new AbortController().signal);
    expect(reads).toHaveLength(16);
    expect(most).toBe(1);
    for (const r of reads) expect([r.image, r.width, r.height, r.bands]).toEqual([0, 256, 256, [0, 1, 2]]);
    const at = (c: number, x: number, y: number) => t[c * SAM_SIDE * SAM_SIDE + y * SAM_SIDE + x]!;
    expect(at(0, 10, 10)).toBeCloseTo((1 - 0.485) / 0.229, 5); // band 1 at 255 is full red
    expect(at(1, 10, 10)).toBeCloseTo((0 - 0.456) / 0.224, 5);
    for (let c = 0; c < 3; c++) expect(at(c, 700 - 256, 600)).toBe(0); // nodata
  });

  it("clips reads to a window smaller than 1024", async () => {
    const { source, reads } = samplesSource({ width: 300, height: 200 }, value, block);
    await readSamInput(source, { x0: 0, y0: 0, width: 300, height: 200 }, [[0, 255], [0, 255], [0, 255]], new AbortController().signal);
    expect(reads.map((r) => [r.x0, r.y0, r.width, r.height])).toEqual([[0, 0, 256, 200], [256, 0, 44, 200]]);
  });
});
