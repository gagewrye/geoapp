import { normalizeLon } from "./ring";

type Labelled = GeoJSON.Feature<GeoJSON.Polygon, { label: number }>;

/** Drawn polygons with a className to labelled features; label = index into classes. */
export function labelFeatures(snapshot: GeoJSON.Feature[]): { classes: string[]; features: Labelled[] } {
  const classes: string[] = [];
  const features: Labelled[] = [];
  for (const f of snapshot) {
    const name = String(f.properties?.className ?? "").trim();
    if (f.geometry.type !== "Polygon" || !name) continue;
    let label = classes.indexOf(name);
    if (label < 0) label = classes.push(name) - 1;
    const coordinates = f.geometry.coordinates.map((ring) => ring.map(([lon, lat]) => [normalizeLon(lon!), lat!]));
    features.push({ type: "Feature", properties: { label }, geometry: { type: "Polygon", coordinates } });
  }
  return { classes, features };
}
