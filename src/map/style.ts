import type { StyleSpecification } from "maplibre-gl";
import { MAX_LAT } from "../core/types";
// Bundled with the app (spec 012, ADR 0014): one request per page load, whatever the view
import basemapUrl from "./basemap.jpg?url";

export const BACKGROUND = "#1d2b3a";

// The basemap is one world-sized quad; magnified past this, its far edge near the far plane loses the depth test to
// the background and flickers navy (spec 045). Above it the ground outside the raster is plain BACKGROUND.
export const BASEMAP_MAXZOOM = 12;

/** Offline style: no tiles, glyphs or sprites; only the bundled basemap image. */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    sources: {
      // MapLibre maps image corners linearly in Mercator, so the file is Web Mercator over +-MAX_LAT
      basemap: { type: "image", url: basemapUrl, coordinates: [[-180, MAX_LAT], [180, MAX_LAT], [180, -MAX_LAT], [-180, -MAX_LAT]] },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": BACKGROUND } },
      // fade 0, as every other raster layer: a re-added basemap tile would fade in from the background (spec 045)
      { id: "basemap", type: "raster", source: "basemap", maxzoom: BASEMAP_MAXZOOM, paint: { "raster-fade-duration": 0 } },
    ],
  };
}
