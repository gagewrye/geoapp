import type { StyleSpecification } from "maplibre-gl";
import { MAX_LAT } from "../core/types";
import { SKY } from "./sky";
// Bundled with the app (spec 012, ADR 0014): one request per page load, whatever the view
import basemapUrl from "./basemap.jpg?url";

export const BACKGROUND = "#1d2b3a";

/** Offline style: no tiles, glyphs or sprites; only the bundled basemap image. */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    sky: SKY,
    sources: {
      // MapLibre maps image corners linearly in Mercator, so the file is Web Mercator over +-MAX_LAT
      basemap: { type: "image", url: basemapUrl, coordinates: [[-180, MAX_LAT], [180, MAX_LAT], [180, -MAX_LAT], [-180, -MAX_LAT]] },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": BACKGROUND } },
      { id: "basemap", type: "raster", source: "basemap" },
    ],
  };
}
