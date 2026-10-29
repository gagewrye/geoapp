import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";
import { paintLabels, tileQuads } from "../core/labelQuads";
import { tileWindow } from "../core/labelStore";
import type { Grid } from "../core/types";
import { beforeSlot, LABEL_OPACITY } from "./layers";

/** Largest bilinear placement error of a quad's pixels, in pixels (spec 018). */
const MAX_ERR = 0.05;

type Corners = [[number, number], [number, number], [number, number], [number, number]];
type Part = { id: string; canvas: HTMLCanvasElement; dx: number; dy: number; corners: Corners };
type Overlay = { width: number; height: number; parts: Part[] };

/** Each stored label tile as one canvas per raster-aligned quad, one texel per pixel, pinned at its corners (ADR 0019). */
// A tile's quads are built once. A redraw repaints its canvases, then play() and pause() re-upload each
// once; callers batch redraws per frame, since a repaint walks the whole tile.
export class LabelOverlays {
  private readonly overlays = new Map<string, Overlay>();

  constructor(private readonly map: MapLibreMap, private readonly grid: Grid) {}

  /** Redraw one tile: create its overlay, repaint it, or remove it when the tile is gone. */
  update(key: string, labels: Uint8Array | undefined, colours: string[]): void {
    let o = this.overlays.get(key);
    if (!labels) {
      if (o) this.remove(key, o);
      return;
    }
    const fresh = !o;
    if (!o) o = this.create(key);
    this.paint(o, labels, colours);
    if (fresh) this.add(key, o);
    else for (const p of o.parts) {
      const s = this.map.getSource<CanvasSource>(p.id);
      s?.play();
      s?.pause();
    }
  }

  /** Remove every overlay (the labels were discarded). */
  clear(): void {
    for (const [key, o] of this.overlays) this.remove(key, o);
  }

  private create(key: string): Overlay {
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    const w = tileWindow(this.grid, x0, y0);
    const quads = tileQuads(this.grid, w, MAX_ERR);
    const parts = quads.map((q, i): Part => {
      const canvas = document.createElement("canvas");
      canvas.width = q.window.width;
      canvas.height = q.window.height;
      const id = quads.length === 1 ? `label-${key}` : `label-${key}-${i}`;
      return { id, canvas, dx: q.window.x0 - w.x0, dy: q.window.y0 - w.y0, corners: q.corners as Corners };
    });
    return { width: w.width, height: w.height, parts };
  }

  private paint(o: Overlay, labels: Uint8Array, colours: string[]): void {
    const img = new ImageData(o.width, o.height);
    paintLabels(labels, colours, img.data);
    for (const p of o.parts) p.canvas.getContext("2d")!.putImageData(img, -p.dx, -p.dy, p.dx, p.dy, p.canvas.width, p.canvas.height);
  }

  private add(key: string, o: Overlay): void {
    this.overlays.set(key, o);
    const before = beforeSlot(this.map, "label-");
    for (const p of o.parts) {
      this.map.addSource(p.id, { type: "canvas", canvas: p.canvas, coordinates: p.corners, animate: false });
      // bilinear between the corners, as tileQuads measured (maplibre-gl 6.16.0, experimental)
      this.map.getSource<CanvasSource>(p.id)!.setWarp("flat");
      this.map.addLayer({ id: p.id, type: "raster", source: p.id,
        paint: { "raster-opacity": LABEL_OPACITY, "raster-fade-duration": 0, "raster-resampling": "nearest" } }, before);
    }
  }

  private remove(key: string, o: Overlay): void {
    this.overlays.delete(key);
    for (const { id } of o.parts) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }
}
