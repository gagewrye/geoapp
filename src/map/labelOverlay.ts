import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";
import { tileWindow } from "../core/labelStore";
import { overlayIndex, overlayPitch, paintOverlay } from "../core/overlay";
import type { Grid } from "../core/types";
import { beforeSlot } from "./layers";

type Corners = [[number, number], [number, number], [number, number], [number, number]];
type Overlay = { id: string; canvas: HTMLCanvasElement; index: Int32Array; corners: Corners };

/** One canvas source per stored label tile, all on one Mercator pixel grid per raster (ADR 0010, 0016). */
// Each tile's index is built once. A redraw repaints the canvas, then play() and pause() re-upload it
// once; callers batch redraws per frame, since a repaint walks the whole tile.
export class LabelOverlays {
  private readonly overlays = new Map<string, Overlay>();
  private readonly pitch: number;

  constructor(private readonly map: MapLibreMap, private readonly grid: Grid) {
    this.pitch = overlayPitch(grid);
  }

  /** Redraw one tile: create its overlay, repaint it, or remove it when the tile is gone. */
  update(key: string, labels: Uint8Array | undefined, colours: string[]): void {
    let o = this.overlays.get(key);
    if (!labels) {
      if (o) this.remove(key, o.id);
      return;
    }
    const fresh = !o;
    if (!o) o = this.create(key);
    this.paint(o, labels, colours);
    if (fresh) this.add(key, o);
    else {
      const s = this.map.getSource<CanvasSource>(o.id);
      s?.play();
      s?.pause();
    }
  }

  /** Remove every overlay (the labels were discarded). */
  clear(): void {
    for (const [key, o] of this.overlays) this.remove(key, o.id);
  }

  private create(key: string): Overlay {
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    const { index, width, height, corners } = overlayIndex(tileWindow(this.grid, x0, y0), this.grid, this.pitch);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return { id: `label-${key}`, canvas, index, corners: corners as Corners };
  }

  private paint(o: Overlay, labels: Uint8Array, colours: string[]): void {
    const img = new ImageData(o.canvas.width, o.canvas.height);
    paintOverlay(o.index, labels, colours, img.data);
    o.canvas.getContext("2d")!.putImageData(img, 0, 0);
  }

  private add(key: string, o: Overlay): void {
    this.overlays.set(key, o);
    this.map.addSource(o.id, { type: "canvas", canvas: o.canvas, coordinates: o.corners, animate: false });
    this.map.addLayer({ id: o.id, type: "raster", source: o.id,
      paint: { "raster-opacity": 0.6, "raster-fade-duration": 0, "raster-resampling": "nearest" } }, beforeSlot(this.map, "label-"));
  }

  private remove(key: string, id: string): void {
    this.overlays.delete(key);
    if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(id)) this.map.removeSource(id);
  }
}
