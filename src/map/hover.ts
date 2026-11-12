import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { beforeSlot } from "./layers";

export const HOVER = "brush-hover";
const FILL = `${HOVER}-fill`, LINE = `${HOVER}-line`;

// Erase mode's ring is dashed so it can be told from Paint's (spec 033)
const DASH = [2, 2];
/** Erase mode's footprint colour: Erase removes any label, so it shows no class colour (spec 058). */
export const ERASE_COLOUR = "#ffffff";

/** Show the brush footprint (a lon/lat ring) as one feature in `colour`, dashed or not, or hide it with null. */
export function showHover(map: MapLibreMap, ring: [number, number][] | null, colour: string, dashed = false): void {
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: ring ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] : [],
  };
  const source = map.getSource<GeoJSONSource>(HOVER);
  if (!source) {
    if (!ring) return;
    // overzoomed tiles must neither round nor simplify the ring (spec 018)
    map.addSource(HOVER, { type: "geojson", data, maxzoom: 24, tolerance: 0 });
    const before = beforeSlot(map, "brush-hover");
    map.addLayer({ id: FILL, type: "fill", source: HOVER, paint: { "fill-color": colour, "fill-opacity": 0.4 } }, before);
    map.addLayer({ id: LINE, type: "line", source: HOVER, paint: { "line-color": colour, "line-width": 1.5, ...(dashed ? { "line-dasharray": DASH } : {}) } }, before);
    return;
  }
  source.setData(data);
  if (map.getPaintProperty(FILL, "fill-color") !== colour) {
    map.setPaintProperty(FILL, "fill-color", colour);
    map.setPaintProperty(LINE, "line-color", colour);
  }
  if ((map.getPaintProperty(LINE, "line-dasharray") !== undefined) !== dashed) map.setPaintProperty(LINE, "line-dasharray", dashed ? DASH : undefined);
}
