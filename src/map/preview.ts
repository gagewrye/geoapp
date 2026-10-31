import type { Map as MapLibreMap } from "maplibre-gl";
import { beforeSlot } from "./layers";

const SOURCE = "preview";

type Preview = { rgba: Uint8ClampedArray; width: number; height: number; corners: [number, number][] };

/** Show the warped preview as a canvas source; a canvas avoids any fetch, unlike an image URL. */
export function showPreview(map: MapLibreMap, p: Preview): void {
  const canvas = document.createElement("canvas");
  canvas.width = p.width;
  canvas.height = p.height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
  const coordinates = p.corners as [[number, number], [number, number], [number, number], [number, number]];
  if (map.getLayer(SOURCE)) map.removeLayer(SOURCE);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  map.addSource(SOURCE, { type: "canvas", canvas, coordinates, animate: false });
  map.addLayer({ id: SOURCE, type: "raster", source: SOURCE, paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } }, beforeSlot(map, "preview"));
}

export type Bounds = [[number, number], [number, number]];

/** The preview's west-south and east-north corners (its corners run NW, NE, SE, SW). */
export function previewBounds(corners: [number, number][]): Bounds {
  const [w, n] = corners[0]!;
  const [e, s] = corners[2]!;
  return [[w, s], [e, n]];
}

/** Fit the raster in view, on open and on Home (spec 035). */
export function fitRaster(map: MapLibreMap, bounds: Bounds): void {
  map.fitBounds(bounds, { padding: 40, animate: false });
}
