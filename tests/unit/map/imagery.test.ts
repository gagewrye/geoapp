import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { IMAGERY_TILES, type Level } from "../../../src/core/imagery";
import type { Grid } from "../../../src/core/types";
import { ImageryLayer } from "../../../src/map/imagery";

// Spec 020 criterion 7 (unit): the tile cache keeps IMAGERY_TILES tiles and drops the least recently used.
function fakeMap(initial: string[] = ["background", "basemap", "preview", "mask", "label-0,0"]) {
  const layers = [...initial];
  const sources = new Set<string>();
  const map = {
    addSource: (id: string) => { sources.add(id); },
    getSource: (id: string) => (sources.has(id) ? { setWarp: () => {}, play: () => {}, pause: () => {} } : undefined),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (l: { id: string }, before?: string) => { layers.splice(before ? layers.indexOf(before) : layers.length, 0, l.id); },
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    removeLayer: (id: string) => { layers.splice(layers.indexOf(id), 1); },
    getLayersOrder: () => [...layers],
    getStyle: () => ({ layers: layers.map((id) => ({ id })) }),
  };
  return { map: map as unknown as MapLibreMap, layers, sources };
}

beforeEach(() => {
  const ctx = { putImageData: () => {} };
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

const GRID: Grid = { width: 100000, height: 64, epsg: 4326, gt: [0, 1e-5, 0, 1, 0, -1e-5] };
const level = (s: number): Level => ({ s, grid: GRID, overview: null });
const tile = (i: number) => ({ x0: i * 8, y0: 0, width: 8, height: 8 });
const rgba = new Uint8ClampedArray(8 * 8 * 4);

describe("ImageryLayer", () => {
  it(`after 600 distinct tiles are drawn, keeps exactly ${IMAGERY_TILES} and drops the 88 least recently used`, () => {
    const { map, sources } = fakeMap();
    const layer = new ImageryLayer(map);
    const key = (i: number) => `1-${i * 8},0`;
    for (let i = 0; i < 300; i++) layer.draw(key(i), level(1), tile(i), rgba);
    for (let i = 0; i < 10; i++) expect(layer.use(key(i))).toBe(true); // seen again, so recently used
    for (let i = 300; i < 600; i++) layer.draw(key(i), level(1), tile(i), rgba);
    expect(layer.size).toBe(IMAGERY_TILES);
    const gone = Array.from({ length: 600 }, (_, i) => i).filter((i) => !layer.use(key(i)));
    expect(gone).toEqual(Array.from({ length: 88 }, (_, i) => i + 10));
    expect([...sources].filter((id) => id.startsWith("imagery-"))).toHaveLength(IMAGERY_TILES);
  });

  it("counts a tile of several quads as that many sources against the cap", () => {
    const { map, sources } = fakeMap();
    const layer = new ImageryLayer(map);
    // 0.01 degree pixels from 85N: a 256 px tile needs several quads (ADR 0019)
    const steep: Level = { s: 1, overview: null, grid: { width: 256, height: 2500, epsg: 4326, gt: [10, 0.01, 0, 85, 0, -0.01] } };
    const peak = { n: 0 };
    const add = map.addSource.bind(map);
    map.addSource = ((id: string, s: never) => { add(id, s); peak.n = Math.max(peak.n, sources.size); }) as typeof map.addSource;
    layer.draw("steep", steep, { x0: 0, y0: 0, width: 256, height: 256 }, new Uint8ClampedArray(256 * 256 * 4));
    expect(sources.size).toBeGreaterThan(1);
    for (let i = 0; i < IMAGERY_TILES - 1; i++) layer.draw(`1-${i * 8},0`, level(1), tile(i), rgba);
    expect(peak.n).toBe(IMAGERY_TILES);
    expect(layer.use("steep")).toBe(false);
  });

  it("puts tiles between the preview and the mask, finer above coarser, and clear() removes them all", () => {
    const { map, layers, sources } = fakeMap();
    const layer = new ImageryLayer(map);
    layer.draw("2-0,0", level(2), tile(0), rgba);
    layer.draw("1-0,0", level(1), tile(0), rgba);
    layer.draw("4-0,0", level(4), tile(0), rgba);
    layer.draw("2-8,0", level(2), tile(1), rgba);
    expect(layers).toEqual(["background", "basemap", "preview", "imagery-4-0,0", "imagery-2-0,0", "imagery-2-8,0", "imagery-1-0,0", "mask", "label-0,0"]);
    layer.clear();
    expect(layers).toEqual(["background", "basemap", "preview", "mask", "label-0,0"]);
    expect([...sources]).toEqual([]);
    expect(layer.size).toBe(0);
  });
});
