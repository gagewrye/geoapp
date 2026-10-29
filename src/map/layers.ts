import type { Map as MapLibreMap } from "maplibre-gl";

// Bottom to top (spec 012 Rendering, spec 003 Display, spec 014 Display).
const SLOTS = ["basemap", "preview", "mask", "label-", "brush-hover"] as const;

/** raster-opacity of the label overlays and the mask preview (one value, so a later control can drive both). */
export const LABEL_OPACITY = 0.6;
export type Slot = (typeof SLOTS)[number];

/** The id of the lowest layer in a slot above `slot`, to insert before; undefined means the top. */
export function beforeSlot(map: MapLibreMap, slot: Slot): string | undefined {
  const above = SLOTS.slice(SLOTS.indexOf(slot) + 1);
  return map.getStyle().layers.find((l) => above.some((s) => l.id.startsWith(s)))?.id;
}
