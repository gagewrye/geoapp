import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";
import type { Window } from "../core/grid";
import { paintLabels, QUAD_ERR, tileQuads, type Quad } from "../core/labelQuads";
import type { Grid } from "../core/types";
import { beforeSlot } from "./layers";

type Corners = [[number, number], [number, number], [number, number], [number, number]];
type Part = { id: string; canvas: HTMLCanvasElement; quad: Quad };

/** Smart select's mask preview (spec 046 scope 6): the window as ADR 0019 quads, in one colour at opacity 0.5, under the brush hover. */
// A new mask in the same window repaints its canvases; another window replaces them.
export class SmartLayer {
  private parts: Part[] = [];
  private window: Window | null = null;

  constructor(private readonly map: MapLibreMap, private readonly grid: Grid) {}

  show(mask: { bits: Uint8Array; window: Window } | null, colour: string): void {
    if (!mask) { this.clear(); return; }
    const w = mask.window;
    const same = this.window && this.window.x0 === w.x0 && this.window.y0 === w.y0 && this.window.width === w.width && this.window.height === w.height;
    if (!same) {
      this.clear();
      this.window = w;
      this.parts = tileQuads(this.grid, w, QUAD_ERR).map((quad, i) => {
        const canvas = document.createElement("canvas");
        canvas.width = quad.window.width;
        canvas.height = quad.window.height;
        return { id: `smart-${i}`, canvas, quad };
      });
    }
    const img = new ImageData(w.width, w.height);
    paintLabels(mask.bits, [colour], img.data);
    for (const p of this.parts) {
      const dx = p.quad.window.x0 - w.x0, dy = p.quad.window.y0 - w.y0;
      p.canvas.getContext("2d")!.putImageData(img, -dx, -dy, dx, dy, p.canvas.width, p.canvas.height);
    }
    if (same) {
      for (const p of this.parts) { const s = this.map.getSource<CanvasSource>(p.id); s?.play(); s?.pause(); }
      return;
    }
    const before = beforeSlot(this.map, "smart");
    for (const p of this.parts) {
      this.map.addSource(p.id, { type: "canvas", canvas: p.canvas, coordinates: p.quad.corners as Corners, animate: false });
      this.map.getSource<CanvasSource>(p.id)!.setWarp("flat");
      this.map.addLayer({ id: p.id, type: "raster", source: p.id,
        paint: { "raster-opacity": 0.5, "raster-fade-duration": 0, "raster-resampling": "nearest" } }, before);
    }
  }

  clear(): void {
    for (const { id } of this.parts) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
    this.parts = [];
    this.window = null;
  }
}
