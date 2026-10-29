import type { Map as MapLibreMap } from "maplibre-gl";
import { beforeSlot } from "./layers";

// Its own source and layer, so local imagery's "preview" layer can sit above it.
const ID = "aef-preview";

type Preview = { rgba: Uint8ClampedArray; width: number; height: number; corners: [number, number][] };

/**
 * Show the AlphaEarth preview below every other layer (layers.ts). It is view-only: a raster
 * layer that the brush never labels. A canvas source avoids any fetch.
 */
export function showAefPreview(map: MapLibreMap, p: Preview): void {
  removeAefPreview(map);
  const canvas = document.createElement("canvas");
  canvas.width = p.width;
  canvas.height = p.height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
  const coordinates = p.corners as [[number, number], [number, number], [number, number], [number, number]];
  map.addSource(ID, { type: "canvas", canvas, coordinates, animate: false });
  map.addLayer({ id: ID, type: "raster", source: ID, paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } }, beforeSlot(map, "aef-preview"));
}

/** Show or hide the preview; it stays loaded, so toggling makes no request. */
export function setAefPreviewVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(ID)) map.setLayoutProperty(ID, "visibility", visible ? "visible" : "none");
}

export function removeAefPreview(map: MapLibreMap): void {
  if (map.getLayer(ID)) map.removeLayer(ID);
  if (map.getSource(ID)) map.removeSource(ID);
}
