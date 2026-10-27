import { describe, expect, it } from "vitest";
import { AEF_BANDS, type Aoi } from "../../../src/core/aef";
import { fit } from "../../../src/core/fit";
import { predictTile } from "../../../src/core/predict";
import { labelSamples } from "../../../src/core/labelSamples";
import { NODATA_OUT } from "../../../src/core/types";
import { cacheSource, memoryStore, PLANE_BYTES } from "../../../src/io/aefCache";

// Tester edges: labels (spec 001, now spec 003's labelSamples) on the AlphaEarth cache (64 bands, NaN = no data, nodata null).
const aoi: Aoi = { epsg: 32617, gt: [500000, 10, 0, 2800000, 0, -10], width: 40, height: 30 };
/** Labels for the AOI window: value v over [x0, x1) x [y0, y1) for each box. */
const labelled = (...boxes: [number, number, number, number, number][]) => {
  const l = new Uint8Array(aoi.width * aoi.height);
  for (const [x0, y0, x1, y1, v] of boxes) for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) l[r * aoi.width + c] = v;
  return l;
};
const BANDS = Array.from({ length: AEF_BANDS }, (_, i) => i + 1);

/** One cached window: west half value +40, east half -40 in every band, rows 0..4 no data (-128). */
async function cached() {
  const store = memoryStore();
  for (let b = 0; b < AEF_BANDS; b++) {
    const q = new Int8Array(PLANE_BYTES).fill(-128);
    for (let r = 5; r < aoi.height; r++) for (let c = 0; c < aoi.width; c++) q[r * 256 + c] = (c < 20 ? 40 : -40) + (b % 2);
    await (await store.band(b)).append(q);
  }
  return cacheSource(aoi, store).readWindow(0, 0, aoi.width, aoi.height);
}

describe("labels on the AEF cache (tester, edges)", () => {
  it("no-data (NaN) labelled pixels are never sampled, and predict as no data", async () => {
    const tile = await cached();
    expect(tile.nodata).toBeNull();
    const { X, y } = labelSamples(tile, labelled([0, 0, 20, 10, 1], [20, 0, 40, 10, 2]), BANDS);
    expect(y).toHaveLength(2 * 20 * 5); // rows 5..9 only
    expect(X.every(Number.isFinite)).toBe(true);
    const model = fit(X, y, BANDS, ["west", "east"], { epochs: 50 });
    const out = predictTile(model, tile);
    for (let c = 0; c < aoi.width; c++) {
      expect(out[2 * aoi.width + c]).toBe(NODATA_OUT);
      expect(out[20 * aoi.width + c]).toBe(c < 20 ? 0 : 1);
    }
  });

  it("labels only over no data give no samples, and fit refuses with the no-samples message", async () => {
    const tile = await cached();
    const { X, y } = labelSamples(tile, labelled([0, 0, 40, 5, 1]), BANDS);
    expect(y).toHaveLength(0);
    expect(() => fit(X, y, BANDS, ["a", "b"])).toThrow("No training samples");
  });

  it("a single class is refused; two classes with samples of only one still give a valid model", async () => {
    const tile = await cached();
    const { X, y } = labelSamples(tile, labelled([0, 5, 20, 30, 1]), BANDS);
    expect(() => fit(X, y, BANDS, ["only"])).toThrow("need 2..255 classes");
    const m = fit(X, y, BANDS, ["a", "b"], { epochs: 20 });
    expect(m.W.flat().every(Number.isFinite)).toBe(true);
    expect(m.bands).toEqual(BANDS);
  });
});
