import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { beforeSlot } from "./layers";

export const HOVER = "brush-hover";
const FILL = `${HOVER}-fill`, LINE = `${HOVER}-line`;

/** Show the brush footprint (a lon/lat ring) as one feature in `colour`, or hide it with null. */
export function showHover(map: MapLibreMap, ring: [number, number][] | null, colour: string): void {
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: ring ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] : [],
  };
  const source = map.getSource<GeoJSONSource>(HOVER);
  if (!source) {
    if (!ring) return;
    map.addSource(HOVER, { type: "geojson", data });
    const before = beforeSlot(map, "brush-hover");
    map.addLayer({ id: FILL, type: "fill", source: HOVER, paint: { "fill-color": colour, "fill-opacity": 0.4 } }, before);
    map.addLayer({ id: LINE, type: "line", source: HOVER, paint: { "line-color": colour, "line-width": 1.5 } }, before);
    return;
  }
  source.setData(data);
  if (map.getPaintProperty(FILL, "fill-color") !== colour) {
    map.setPaintProperty(FILL, "fill-color", colour);
    map.setPaintProperty(LINE, "line-color", colour);
  }
}
