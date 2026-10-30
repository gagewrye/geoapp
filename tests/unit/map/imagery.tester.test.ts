import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { toLonLat } from "../../../src/core/crs";
import { IMAGERY_TILES, imageryQuads, planView, type Level, type Overview } from "../../../src/core/imagery";
import type { Grid } from "../../../src/core/types";
import { tileKey } from "../../../src/io/imageryLoader";
import { ImageryLayer } from "../../../src/map/imagery";

// Spec 020, tester: the tile cap against one view's own tiles, and re-drawing a kept tile.
function fakeMap() {
  const layers = ["background", "basemap", "preview", "mask"];
  const sources = new Set<string>();
  const map = {
    addSource: (id: string) => { sources.add(id); },
    getSource: (id: string) => (sources.has(id) ? { setWarp: () => {} } : undefined),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (l: { id: string }, before?: string) => { layers.splice(before ? layers.indexOf(before) : layers.length, 0, l.id); },
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    removeLayer: (id: string) => { layers.splice(layers.indexOf(id), 1); },
    getLayersOrder: () => [...layers],
    getStyle: () => ({ layers: layers.map((id) => ({ id })) }),
  };
  return { map: map as unknown as MapLibreMap, sources, layers };
}

beforeEach(() => {
  const ctx = { putImageData: () => {} };
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("ImageryLayer, tester", () => {
  it("drawing a kept tile again replaces it without counting it twice", () => {
    const { map, sources } = fakeMap();
    const layer = new ImageryLayer(map);
    const grid: Grid = { width: 100000, height: 64, epsg: 4326, gt: [0, 1e-5, 0, 1, 0, -1e-5] };
    const level: Level = { s: 1, grid, overview: null };
    const rgba = new Uint8ClampedArray(8 * 8 * 4);
    for (let n = 0; n < 3; n++) for (let i = 0; i < IMAGERY_TILES; i++) layer.draw(`1-${i * 8},0`, level, { x0: i * 8, y0: 0, width: 8, height: 8 }, rgba);
    expect(layer.size).toBe(IMAGERY_TILES);
    expect(sources.size).toBe(IMAGERY_TILES);
    for (let i = 0; i < IMAGERY_TILES; i++) expect(layer.use(`1-${i * 8},0`)).toBe(true);
  });

  // A Landsat-like 30 m UTM 18N file at 45N with overviews, viewed at 1920 x 1080 CSS px, 120 m per CSS px: planView picks
  // s = 2 with 144 tiles (within IMAGERY_TILES / 2), but those tiles need 558 quads, and the layer caps quads at 512. Drawing
  // the view centre first evicts its own centre tiles; every later moveend re-reads them.
  it("every tile of one planned view is still kept after the view is drawn (was B1)", () => {
    const px = 30, n = 7800, northing = 5000000;
    const grid: Grid = { epsg: 32618, gt: [500000 - (n * px) / 2, px, 0, northing + (n * px) / 2, 0, -px], width: n, height: n };
    const ovs: Overview[] = [2, 4, 8, 16].map((k, i) => ({ index: i + 1, width: Math.ceil(n / k), height: Math.ceil(n / k) }));
    const [lon, lat] = toLonLat(32618, 500000, northing);
    const mpp = 120, hl = (1920 * mpp) / 2 / (111320 * Math.cos((lat * Math.PI) / 180)), hh = (1080 * mpp) / 2 / 111320;
    const plan = planView(grid, ovs, [lon - hl, lat - hh, lon + hl, lat + hh], 1920, 1080)!;
    expect(plan.tiles.length).toBeLessThanOrEqual(IMAGERY_TILES / 2);
    const { map } = fakeMap();
    const layer = new ImageryLayer(map);
    for (const t of plan.tiles) layer.draw(tileKey(plan.level, t), plan.level, t, new Uint8ClampedArray(t.width * t.height * 4));
    const quads = plan.tiles.reduce((s, t) => s + imageryQuads(plan.level, t).length, 0);
    const lost = plan.tiles.filter((t) => !layer.use(tileKey(plan.level, t)));
    expect(lost, `s = ${plan.level.s}, ${plan.tiles.length} tiles, ${quads} quads`).toEqual([]);
  }, 120_000);
});
