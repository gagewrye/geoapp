import type { SkySpecification } from "maplibre-gl";

/**
 * Glow only: transparent colours keep the CSS stars visible (spec 015). The blend reaches 0 at
 * zoom 11, before the globe-to-Mercator morph (ADR 0004). Its own module so Playwright can import it.
 */
export const SKY = {
  "sky-color": "rgba(0,0,0,0)",
  "horizon-color": "rgba(0,0,0,0)",
  "fog-color": "rgba(0,0,0,0)",
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 1, 11, 0],
} as const satisfies SkySpecification;
