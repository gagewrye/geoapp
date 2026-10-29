import { GlobeControl, Map as MapLibreMap, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre locates its worker via import.meta.url at runtime, which Vite cannot see; bundle it explicitly.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
import { baseStyle } from "./style";

export function createMap(container: HTMLElement): MapLibreMap {
  // scrollZoom's options only take effect at construction: enable() returns early once enabled (spec 009)
  const map = new MapLibreMap({ container, style: baseStyle(), center: [0, 20], zoom: 1.5, attributionControl: false, scrollZoom: { around: "center" } });
  map.addControl(new NavigationControl());
  map.addControl(new GlobeControl());
  return map;
}
