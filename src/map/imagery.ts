import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";
import type { Window } from "../core/grid";
import { IMAGERY_TILES, imageryQuads, type Level } from "../core/imagery";
import type { TileSink } from "../io/imageryLoader";
import { beforeSlot } from "./layers";

type Corners = [[number, number], [number, number], [number, number], [number, number]];
const PREFIX = "imagery-";

/** Imagery tiles as canvas sources placed by ADR 0019 quads, the IMAGERY_TILES most recently used kept (spec 020). */
// Map order is recency: use() and draw() move a tile to the end, so eviction takes the first. The cap counts tiles,
// not quads (spec 020 A1): a tile's quads partition its texels, and a view's at most IMAGERY_TILES / 2 tiles,
// all used or drawn last, are never the least recently used.
export class ImageryLayer implements TileSink {
  private readonly tiles = new Map<string, string[]>();

  constructor(private readonly map: MapLibreMap) {}

  get size(): number { return this.tiles.size; }

  use(key: string): boolean {
    const ids = this.tiles.get(key);
    if (!ids) return false;
    this.tiles.delete(key);
    this.tiles.set(key, ids);
    return true;
  }

  draw(key: string, level: Level, tile: Window, rgba: Uint8ClampedArray<ArrayBuffer>): void {
    this.remove(key);
    const quads = imageryQuads(level, tile);
    // evict first, so the count never passes the cap even while this tile is added; a tile goes with all its quads
    for (const old of [...this.tiles.keys()]) {
      if (this.tiles.size < IMAGERY_TILES) break;
      this.remove(old);
    }
    const img = new ImageData(rgba, tile.width, tile.height);
    const before = this.before(level.s);
    const ids: string[] = [];
    try {
      for (const [i, q] of quads.entries()) {
        const id = quads.length === 1 ? `${PREFIX}${key}` : `${PREFIX}${key}-${i}`;
        ids.push(id); // before adding, so a throw below removes whatever part of it was added
        const canvas = document.createElement("canvas");
        canvas.width = q.window.width;
        canvas.height = q.window.height;
        const dx = q.window.x0 - tile.x0, dy = q.window.y0 - tile.y0;
        canvas.getContext("2d")!.putImageData(img, -dx, -dy, dx, dy, q.window.width, q.window.height);
        this.map.addSource(id, { type: "canvas", canvas, coordinates: q.corners as Corners, animate: false });
        this.map.getSource<CanvasSource>(id)!.setWarp("flat"); // bilinear between the corners, as for label tiles (ADR 0019)
        this.map.addLayer({ id, type: "raster", source: id, paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } }, before);
      }
    } catch (e) {
      // untracked quads would survive clear() and block a retry with "source already exists"
      this.removeIds(ids);
      throw e;
    }
    this.tiles.set(key, ids);
  }

  /** Remove every tile (another raster opened). */
  clear(): void {
    for (const key of [...this.tiles.keys()]) this.remove(key);
  }

  /** Finer tiles draw above coarser: below the lowest imagery layer of a smaller step, else at the top of the slot. */
  private before(s: number): string | undefined {
    const finer = this.map.getLayersOrder().find((id) => id.startsWith(PREFIX) && Number(id.slice(PREFIX.length).split("-")[0]) < s);
    return finer ?? beforeSlot(this.map, "imagery-");
  }

  private remove(key: string): void {
    const ids = this.tiles.get(key);
    if (!ids) return;
    this.tiles.delete(key);
    this.removeIds(ids);
  }

  private removeIds(ids: string[]): void {
    for (const id of ids) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }
}
