import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { IMAGERY_TILES, type Level } from "../../../src/core/imagery";
import * as labelQuads from "../../../src/core/labelQuads";
import type { Grid } from "../../../src/core/types";
import { ImageryLayer } from "../../../src/map/imagery";

// Spec 026 criterion 5: imagery quads are cached by level and tile key for the raster's life.
function fakeMap() {
  const layers: string[] = [], sources = new Set<string>();
  return {
    addSource: (id: string) => { sources.add(id); },
    getSource: (id: string) => (sources.has(id) ? { setWarp: () => {} } : undefined),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (l: { id: string }, before?: string) => { layers.splice(before ? layers.indexOf(before) : layers.length, 0, l.id); },
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    removeLayer: (id: string) => { layers.splice(layers.indexOf(id), 1); },
    getLayersOrder: () => [...layers],
    getStyle: () => ({ layers: layers.map((id) => ({ id })) }),
  } as unknown as MapLibreMap;
}

beforeEach(() => {
  const ctx = { putImageData: () => {} };
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const GRID: Grid = { width: 100000, height: 64, epsg: 4326, gt: [0, 1e-5, 0, 1, 0, -1e-5] };
const level: Level = { s: 1, grid: GRID, overview: null };
const tile = (i: number) => ({ x0: i * 8, y0: 0, width: 8, height: 8 });
const key = (i: number) => `1-${i * 8},0`;
const rgba = new Uint8ClampedArray(8 * 8 * 4);

describe("imagery quad cache (spec 026 criterion 5)", () => {
  it("an imagery tile evicted and drawn again calls tileQuads once in total", () => {
    const spy = vi.spyOn(labelQuads, "tileQuads");
    const layer = new ImageryLayer(fakeMap());
    for (let i = 0; i <= IMAGERY_TILES; i++) layer.draw(key(i), level, tile(i), rgba);
    expect(layer.use(key(0))).toBe(false); // evicted
    const first = spy.mock.calls.filter(([, w]) => w.x0 === 0).length;
    layer.draw(key(0), level, tile(0), rgba);
    expect(spy.mock.calls.filter(([, w]) => w.x0 === 0)).toHaveLength(1);
    expect(first).toBe(1);
  });

  it("forgets the quads when the raster changes (clear)", () => {
    const spy = vi.spyOn(labelQuads, "tileQuads");
    const layer = new ImageryLayer(fakeMap());
    layer.draw(key(0), level, tile(0), rgba);
    layer.clear();
    layer.draw(key(0), level, tile(0), rgba);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
