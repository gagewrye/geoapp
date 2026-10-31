import { GlobeControl, Map as MapLibreMap, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre locates its worker via import.meta.url at runtime, which Vite cannot see; bundle it explicitly.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
import { baseStyle } from "./style";

/** A ⌂ button that zooms to the raster (spec 035), placed under the zoom buttons. */
function homeControl(home: () => void) {
  const div = document.createElement("div");
  div.className = "maplibregl-ctrl maplibregl-ctrl-group";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "maplibregl-ctrl-home";
  b.setAttribute("aria-label", "Zoom to raster");
  b.title = "Zoom to raster (Home)";
  b.textContent = "⌂";
  b.addEventListener("click", home);
  div.append(b);
  return { onAdd: () => div, onRemove: () => div.remove() };
}

export function createMap(container: HTMLElement, home: () => void = () => {}): MapLibreMap {
  // scrollZoom's options only take effect at construction: enable() returns early once enabled (spec 009)
  const map = new MapLibreMap({ container, style: baseStyle(), center: [0, 20], zoom: 1.5, attributionControl: false, scrollZoom: { around: "center" } });
  map.addControl(new NavigationControl());
  map.addControl(homeControl(home));
  map.addControl(new GlobeControl());
  return map;
}
