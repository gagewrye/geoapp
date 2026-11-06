import type { FilterSpecification, GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { applyAffine, toLonLat } from "../core/crs";
import type { Grid } from "../core/types";
import { beforeSlot } from "./layers";

const SOURCE = "polygon";
/** Two corners this close on screen count as the same one (a closing click, or a double click's second press). */
export const NEAR_PX = 8;

/** The Polygon tool's outline (spec 054): its corners, the area Enter would fill, and a line on to the pointer, under the brush hover. */
export function polygonLayer(map: MapLibreMap) {
  let grid: Grid | null = null, ring: [number, number][] = [], pointer: [number, number] | null = null, frame = 0, added = false;
  // a corner is its pixel's centre
  const lonLat = ([c, r]: [number, number]) => toLonLat(grid!.epsg, ...applyAffine(grid!.gt, c + 0.5, r + 0.5));
  const feature = (kind: string, geometry: GeoJSON.Geometry): GeoJSON.Feature => ({ type: "Feature", properties: { kind }, geometry });

  const draw = () => {
    frame = 0;
    const features: GeoJSON.Feature[] = [];
    if (ring.length >= 3) features.push(feature("area", { type: "Polygon", coordinates: [[...ring, ring[0]!]] }));
    const line = pointer && ring.length ? [...ring, pointer] : ring;
    if (line.length >= 2) features.push(feature("line", { type: "LineString", coordinates: line.length >= 3 ? [...line, ring[0]!] : line }));
    ring.forEach((p, i) => features.push(feature(i === 0 ? "first" : "corner", { type: "Point", coordinates: p })));
    if (added) map.getSource<GeoJSONSource>(SOURCE)?.setData({ type: "FeatureCollection", features });
  };
  const later = () => { frame ||= requestAnimationFrame(draw); };

  const kind = (k: string[]): FilterSpecification => ["in", ["get", "kind"], ["literal", k]];
  // The source, layers and pointer listeners come with the first outline, so a page that never draws one has none
  const add = (colour: string) => {
    added = true;
    map.on("mousemove", (e) => { if (ring.length) { pointer = [e.lngLat.lng, e.lngLat.lat]; later(); } });
    map.on("mouseout", () => { if (pointer) { pointer = null; later(); } });
    // overzoomed tiles must neither round nor simplify the outline (as spec 018's hover)
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] }, maxzoom: 24, tolerance: 0 });
    const before = beforeSlot(map, "polygon");
    map.addLayer({ id: "polygon-area", type: "fill", source: SOURCE, filter: kind(["area"]), paint: { "fill-color": colour, "fill-opacity": 0.35 } }, before);
    // a dark casing keeps the line visible over labels of its own colour
    map.addLayer({ id: "polygon-casing", type: "line", source: SOURCE, filter: kind(["line"]), paint: { "line-color": "#000", "line-width": 4, "line-opacity": 0.6 } }, before);
    map.addLayer({ id: "polygon-line", type: "line", source: SOURCE, filter: kind(["line"]), paint: { "line-color": colour, "line-width": 2 } }, before);
    map.addLayer({ id: "polygon-corner", type: "circle", source: SOURCE, filter: kind(["corner", "first"]),
      paint: { "circle-radius": ["case", ["==", ["get", "kind"], "first"], 6, 4], "circle-color": "#fff", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } }, before);
  };

  return {
    /** A raster opened: its grid, and no outline. */
    open(g: Grid): void { grid = g; ring = []; pointer = null; draw(); },
    /** The outline through these raster cells in `colour`, or none. */
    show(corners: [number, number][] | null, colour: string): void {
      if (!grid) return;
      ring = (corners ?? []).map(lonLat);
      if (!ring.length) pointer = null;
      if (!added) { if (!ring.length) return; add(colour); }
      else if (map.getPaintProperty("polygon-line", "line-color") !== colour) {
        map.setPaintProperty("polygon-line", "line-color", colour);
        map.setPaintProperty("polygon-area", "fill-color", colour);
      }
      draw();
    },
    /** Raster cells a and b lie within NEAR_PX screen pixels of each other. */
    near(a: [number, number], b: [number, number]): boolean {
      if (!grid) return false;
      const p = map.project(lonLat(a)), q = map.project(lonLat(b));
      return Math.hypot(p.x - q.x, p.y - q.y) <= NEAR_PX;
    },
  };
}
