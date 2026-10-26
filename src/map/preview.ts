import type { Map as MapLibreMap } from "maplibre-gl";

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
  // keep drawn polygons (terra-draw "td-" layers) above the preview
  const before = map.getStyle().layers.find((l) => l.id.startsWith("td-"))?.id;
  map.addLayer({ id: SOURCE, type: "raster", source: SOURCE, paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } }, before);
}

export function fitToPreview(map: MapLibreMap, corners: [number, number][]): void {
  const [w, n] = corners[0]!;
  const [e, s] = corners[2]!;
  map.fitBounds([[w, s], [e, n]], { padding: 40, animate: false });
}
