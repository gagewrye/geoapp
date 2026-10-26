import { describe, expect, it } from "vitest";
import { AEF_BANDS, type Aoi } from "../../../src/core/aef";
import { fit } from "../../../src/core/fit";
import { predictTile } from "../../../src/core/predict";
import { samplePixels } from "../../../src/core/sample";
import { NODATA_OUT } from "../../../src/core/types";
import { cacheSource, memoryStore, WINDOW_BYTES } from "../../../src/io/aefCache";

// Tester edges: spec 001 labeling on the AlphaEarth cache (64 bands, NaN = no data, nodata null).
const aoi: Aoi = { epsg: 32617, gt: [500000, 10, 0, 2800000, 0, -10], width: 40, height: 30 };
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const BANDS = Array.from({ length: AEF_BANDS }, (_, i) => i + 1);

/** One cached window: west half value +40, east half -40 in every band, rows 0..4 no data (-128). */
async function cached() {
  const store = memoryStore();
  const q = new Int8Array(WINDOW_BYTES).fill(-128);
  for (let b = 0; b < AEF_BANDS; b++) for (let r = 5; r < aoi.height; r++) for (let c = 0; c < aoi.width; c++) {
    q[b * 65536 + r * 256 + c] = (c < 20 ? 40 : -40) + (b % 2);
  }
  await store.write(0, q);
  return cacheSource(aoi, store).readWindow(0, 0, aoi.width, aoi.height);
}

describe("labels on the AEF cache (tester, edges)", () => {
  it("no-data (NaN) pixels under a polygon are never sampled, and predict as no data", async () => {
    const tile = await cached();
    expect(tile.nodata).toBeNull();
    const { X, y } = samplePixels(tile, [{ label: 0, rings: [rect(0, 0, 20, 10)] }, { label: 1, rings: [rect(20, 0, 40, 10)] }], BANDS);
    expect(y).toHaveLength(2 * 20 * 5); // rows 5..9 only
    expect(X.every(Number.isFinite)).toBe(true);
    const model = fit(X, y, BANDS, ["west", "east"], { epochs: 50 });
    const out = predictTile(model, tile);
    for (let c = 0; c < aoi.width; c++) {
      expect(out[2 * aoi.width + c]).toBe(NODATA_OUT);
      expect(out[20 * aoi.width + c]).toBe(c < 20 ? 0 : 1);
    }
  });

  it("a polygon only over no data gives no samples, and fit refuses with the no-samples message", async () => {
    const tile = await cached();
    const { X, y } = samplePixels(tile, [{ label: 0, rings: [rect(0, 0, 40, 5)] }], BANDS);
    expect(y).toHaveLength(0);
    expect(() => fit(X, y, BANDS, ["a", "b"])).toThrow("No training samples");
  });

  it("a single class is refused; two classes with samples of only one still give a valid model", async () => {
    const tile = await cached();
    const { X, y } = samplePixels(tile, [{ label: 0, rings: [rect(0, 5, 20, 30)] }], BANDS);
    expect(() => fit(X, y, BANDS, ["only"])).toThrow("need 2..255 classes");
    const m = fit(X, y, BANDS, ["a", "b"], { epochs: 20 });
    expect(m.W.flat().every(Number.isFinite)).toBe(true);
    expect(m.bands).toEqual(BANDS);
  });
});
