import type { Map as MapLibreMap } from "maplibre-gl";
import { MAX_BLOCK_BYTES, planView } from "../core/imagery";
import { ImageryLoader } from "../io/imageryLoader";
import type { ImagerySource, RasterSource } from "../io/source";
import { ImageryLayer } from "../map/imagery";
import { MESSAGES } from "./messages";

const canRead = (s: RasterSource): s is ImagerySource => Boolean(s.block && s.overviews && s.readSamples);

/** Full-resolution imagery over the preview (spec 020): tiles for each view once the map stops moving. */
export function initImagery(map: MapLibreMap, say: (text: string) => void = () => {}) {
  const layer = new ImageryLayer(map);
  /** The block limit; e2e tests lower it through the page hook. */
  const limits = { maxBlockBytes: MAX_BLOCK_BYTES };
  let open: { source: ImagerySource; loader: ImageryLoader } | null = null;
  let reported = false; // a tile read failed for this raster, and the user was told (spec 020 A1)

  const update = () => {
    if (!open) return;
    const { width, height, epsg, gt } = open.source.meta;
    const b = map.getBounds(), c = map.getContainer();
    open.loader.show(planView({ width, height, epsg, gt }, open.source.overviews,
      [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], c.clientWidth, c.clientHeight));
  };
  map.on("moveend", update);

  return {
    limits,
    /** The open raster's tile reads are queued or in flight. */
    busy: () => open?.loader.busy() ?? false,
    /** Drop every tile and read (a raster opened). */
    clear(): void {
      open?.loader.stop();
      open = null;
      layer.clear();
    },
    /** Start tiles for a raster whose preview shows with these ranges; returns why full resolution is off, or null. */
    open(source: RasterSource, ranges: [number, number][]): string | null {
      this.clear();
      if (!canRead(source)) return null;
      if (source.block.bytes > limits.maxBlockBytes) return MESSAGES.largeBlocks(source.block.bytes, limits.maxBlockBytes);
      reported = false;
      const failed = () => { if (!reported) { reported = true; say(MESSAGES.imageryUnreadable); } };
      open = { source, loader: new ImageryLoader(source, ranges, layer, failed) };
      update();
      return null;
    },
  };
}
