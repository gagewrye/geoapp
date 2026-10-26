import type { StyleSpecification } from "maplibre-gl";

export const BACKGROUND = "#1d2b3a";

/** Offline style: no tiles, glyphs or sprites, so the map makes no network requests. */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": BACKGROUND } }],
  };
}
