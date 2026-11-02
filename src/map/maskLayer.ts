import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";
import { tileWindow } from "../core/labelStore";
import { fillPreview, hideWindow, paintPreview, unfillPreview, type CellBuckets } from "../core/maskPreview";
import { TILE_SIZE } from "../core/types";
import { beforeSlot, labelViewProps } from "./layers";

const ID = "mask"; // not "label-...": beforeSlot and the overlay tests treat those ids as tile overlays

type Corners = [[number, number], [number, number], [number, number], [number, number]];

/** A raster's preview grid (previewCells and cellBuckets), kept for the raster's life. */
export type PreviewGrid = { cells: Int32Array; buckets: CellBuckets; width: number; height: number; corners: [number, number][] };

/** Every label at preview resolution, as one canvas source under the label overlays (specs 014, 048). */
// Values are the mask base's, overwritten in each stored tile's pixels; the base's own array is never written,
// since spec 031 saves it. Pixels of tiles with an overlay are hidden, so the overlay alone shows there.
export class MaskLayer {
  private readonly canvas = document.createElement("canvas");
  private readonly hidden: Uint8Array;
  readonly values: Uint8Array;
  private base: Uint8Array | null = null;
  private added = false;

  constructor(private readonly map: MapLibreMap, private readonly dims: { width: number; height: number }, private readonly grid: PreviewGrid) {
    this.canvas.width = grid.width;
    this.canvas.height = grid.height;
    this.hidden = new Uint8Array(grid.width * grid.height);
    this.values = new Uint8Array(grid.width * grid.height);
  }

  /** Starts again from this base's values (null: none); the caller then fills every stored tile. */
  setBase(base: Uint8Array | null): void {
    this.base = base;
    if (base) this.values.set(base); else this.values.fill(0);
  }

  /** Shows a stored tile's labels in its preview pixels, or the base's again when it has none. */
  fill(key: string, labels: Uint8Array | undefined): void {
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    if (!this.within(x0, y0)) return;
    if (labels) fillPreview(this.values, this.grid.cells, this.grid.buckets, tileWindow(this.dims, x0, y0), labels);
    else unfillPreview(this.values, this.base, this.grid.buckets, x0, y0);
  }

  /** Hides (on) or shows the tile's preview pixels: hidden while it has an overlay. */
  hide(key: string, on: boolean): void {
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    if (this.within(x0, y0)) hideWindow(this.hidden, this.grid.buckets, x0, y0, on);
  }

  /** Repaints the canvas in the class colours and re-uploads it once (ADR 0010's play/pause), adding the layer the first time. */
  paint(colours: string[]): void {
    const img = new ImageData(this.grid.width, this.grid.height);
    paintPreview(this.values, this.hidden, colours, img.data);
    this.canvas.getContext("2d")!.putImageData(img, 0, 0);
    if (!this.added) {
      this.added = true;
      this.map.addSource(ID, { type: "canvas", canvas: this.canvas, coordinates: this.grid.corners as Corners, animate: false });
      const view = labelViewProps(this.map); // spec 016: Opacity and Show labels
      this.map.addLayer({ id: ID, type: "raster", source: ID,
        paint: { ...view.paint, "raster-fade-duration": 0, "raster-resampling": "nearest" }, layout: view.layout }, beforeSlot(this.map, "mask"));
      return;
    }
    const s = this.map.getSource<CanvasSource>(ID);
    s?.play();
    s?.pause();
  }

  /** Takes the layer off the map; the next paint adds it again. */
  remove(): void {
    this.added = false;
    if (this.map.getLayer(ID)) this.map.removeLayer(ID);
    if (this.map.getSource(ID)) this.map.removeSource(ID);
  }

  // a key a test set outside the raster has no preview pixels
  private within(x0: number, y0: number): boolean {
    return x0 >= 0 && y0 >= 0 && x0 < this.dims.width && y0 < this.dims.height && x0 % TILE_SIZE === 0 && y0 % TILE_SIZE === 0;
  }
}
