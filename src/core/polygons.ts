import { fromLonLat, invertAffine, projString } from "./crs";
import type { Affine, PixelPolygon } from "./types";

/** Lon/lat polygons to raster [col,row] polygons in the raster's own pixel grid. */
export function toPixelPolygons(
  features: GeoJSON.Feature<GeoJSON.Polygon, { label: number }>[],
  epsg: number,
  gt: Affine,
): PixelPolygon[] {
  projString(epsg); // throws on unsupported CRS even with no features
  return features.map((f) => ({
    label: f.properties.label,
    rings: f.geometry.coordinates.map((ring) =>
      ring.map(([lon, lat]) => {
        const [x, y] = fromLonLat(epsg, lon!, lat!);
        return invertAffine(gt, x, y);
      }),
    ),
  }));
}
