import type { ExpressionSpecification, FilterSpecification, GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { handleNear, handlePoints, type Box, type Handle, type Rect } from "../core/boxes";
import { applyAffine, toLonLat } from "../core/crs";
import { footprintRing } from "../core/pixel";
import type { Grid } from "../core/types";
import { beforeSlot } from "./layers";

// The boxes, and the one being drawn, moved or resized: each a source with fill, casing, line and handle layers
const SOURCES = ["boxes", "boxes-edit"] as const;
const PARTS = ["fill", "casing", "line", "handle"] as const;
const IDS = SOURCES.flatMap((s) => PARTS.map((p) => `${s}-${p}`));
const BASE: Record<(typeof PARTS)[number], ExpressionSpecification> = {
  fill: ["==", ["geometry-type"], "Polygon"], casing: ["==", ["geometry-type"], "Polygon"],
  line: ["==", ["geometry-type"], "Polygon"], handle: ["==", ["geometry-type"], "Point"],
};
type Feature = GeoJSON.Feature<GeoJSON.Geometry, { id: number; colour: string; selected: boolean }>;

/** The boxes on the map (spec 064), in slot `boxes`: a class-colour ring on a dark casing over a faint fill, and the selected box's handles. */
export function boxLayer(map: MapLibreMap) {
  let grid: Grid | null = null, added = false, shown = true, hidden: number | null = null;
  const lonLat = (x: number, y: number) => toLonLat(grid!.epsg, ...applyAffine(grid!.gt, x, y));
  const features = (r: Rect, props: Feature["properties"], handles: boolean): Feature[] => [
    { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [footprintRing(grid!, { x0: r.x0, y0: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 })] } },
    ...(handles ? handlePoints(r).map((h): Feature => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: lonLat(h.x, h.y) } })) : []),
  ];
  const set = (source: string, fs: Feature[]) => map.getSource<GeoJSONSource>(source)?.setData({ type: "FeatureCollection", features: fs });
  /** Filters the edited box out of the boxes source, by layer filter, so a drag never sets that source's data. */
  const filter = (id: number | null) => {
    if (id === hidden) return;
    hidden = id;
    for (const p of PARTS) map.setFilter(`boxes-${p}`, (id === null ? BASE[p] : ["all", BASE[p], ["!=", ["get", "id"], id]]) as FilterSpecification);
  };
  const selected: ExpressionSpecification = ["get", "selected"];
  // The sources and layers come with the first box, so a page that never draws one has none
  const add = () => {
    added = true;
    const before = beforeSlot(map, "boxes"), layout = { visibility: shown ? "visible" as const : "none" as const };
    for (const s of SOURCES) {
      // overzoomed tiles must neither round nor simplify the edges (as spec 018's hover)
      map.addSource(s, { type: "geojson", data: { type: "FeatureCollection", features: [] }, maxzoom: 24, tolerance: 0 });
      map.addLayer({ id: `${s}-fill`, type: "fill", source: s, filter: BASE.fill, layout, paint: { "fill-color": ["get", "colour"], "fill-opacity": 0.1 } }, before);
      // a dark casing keeps the ring visible over labels and imagery of its own colour
      map.addLayer({ id: `${s}-casing`, type: "line", source: s, filter: BASE.casing, layout, paint: { "line-color": "#000", "line-opacity": 0.6, "line-width": ["case", selected, 5, 4] } }, before);
      map.addLayer({ id: `${s}-line`, type: "line", source: s, filter: BASE.line, layout, paint: { "line-color": ["get", "colour"], "line-width": ["case", selected, 3, 2] } }, before);
      map.addLayer({ id: `${s}-handle`, type: "circle", source: s, filter: BASE.handle, layout,
        paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } }, before);
    }
  };

  return {
    /** A raster opened: its grid, and no boxes. */
    open(g: Grid): void { grid = g; if (added) { filter(null); for (const s of SOURCES) set(s, []); } },
    /** Draws every box in its class colour (value - 1 indexes colours); the selected one thicker, with its handles when handles is true. */
    show(boxes: Iterable<Box>, colours: string[], selected: number | null, handles: boolean): void {
      if (!grid) return;
      const fs: Feature[] = [];
      for (const b of boxes) fs.push(...features(b, { id: b.id, colour: colours[b.value - 1] ?? "#888", selected: b.id === selected }, handles && b.id === selected));
      if (!added) { if (!fs.length) return; add(); }
      set("boxes", fs);
    },
    /** The box being edited, with handles, or none; hide is the stored box it replaces while the drag lasts (none for a new box). */
    edit(r: Rect | null, colour: string, hide: number | null = null): void {
      if (!grid || (!added && !r)) return;
      if (!added) add();
      filter(r ? hide : null);
      set("boxes-edit", r ? features(r, { id: 0, colour, selected: true }, true) : []);
    },
    /** Show (H) and the peek hide boxes and handles (spec 064 scope 5); opacity is the masks' alone. */
    visible(on: boolean): void {
      shown = on;
      if (added) for (const id of IDS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    },
    /** The handle of r within 6 px of canvas point (x, y), corners first; null when none is, or no raster is open. */
    handleAt(r: Rect, x: number, y: number): Handle | null {
      if (!grid) return null;
      return handleNear(handlePoints(r).map((h) => { const p = map.project(lonLat(h.x, h.y)); return { handle: h.handle, x: p.x, y: p.y }; }), x, y);
    },
  };
}
