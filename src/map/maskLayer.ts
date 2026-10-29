import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";
import { hideWindow, paintPreview, type MaskPreview } from "../core/maskPreview";
import { beforeSlot, LABEL_OPACITY } from "./layers";

const ID = "mask"; // not "label-...": beforeSlot and the overlay tests treat those ids as tile overlays

type Corners = [[number, number], [number, number], [number, number], [number, number]];

/** The mask base as one preview-resolution canvas source under the label overlays (spec 014 Display). */
// Pixels whose cell lies in a stored tile are hidden, so that tile's full-resolution overlay alone shows there.
export class MaskLayer {
  private readonly canvas = document.createElement("canvas");
  private readonly hidden: Uint8Array;
  private readonly stored = new Set<string>();
  private added = false;

  constructor(private readonly map: MapLibreMap, private readonly preview: MaskPreview) {
    this.canvas.width = preview.width;
    this.canvas.height = preview.height;
    this.hidden = new Uint8Array(preview.width * preview.height);
  }

  /** Records whether key has a stored tile; true when that changed (the layer then needs a repaint). */
  setStored(key: string, stored: boolean): boolean {
    if (this.stored.has(key) === stored) return false;
    if (stored) this.stored.add(key); else this.stored.delete(key);
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    hideWindow(this.hidden, this.preview.buckets, x0, y0, stored);
    return true;
  }

  /** Repaints the canvas in the class colours and re-uploads it once (ADR 0010's play/pause). */
  paint(colours: string[]): void {
    const img = new ImageData(this.preview.width, this.preview.height);
    paintPreview(this.preview.values, this.hidden, colours, img.data);
    this.canvas.getContext("2d")!.putImageData(img, 0, 0);
    if (!this.added) {
      this.added = true;
      this.map.addSource(ID, { type: "canvas", canvas: this.canvas, coordinates: this.preview.corners as Corners, animate: false });
      this.map.addLayer({ id: ID, type: "raster", source: ID,
        paint: { "raster-opacity": LABEL_OPACITY, "raster-fade-duration": 0, "raster-resampling": "nearest" } }, beforeSlot(this.map, "mask"));
      return;
    }
    const s = this.map.getSource<CanvasSource>(ID);
    s?.play();
    s?.pause();
  }

  remove(): void {
    if (this.map.getLayer(ID)) this.map.removeLayer(ID);
    if (this.map.getSource(ID)) this.map.removeSource(ID);
  }
}
