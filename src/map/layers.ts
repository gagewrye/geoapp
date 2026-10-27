import type { Map as MapLibreMap } from "maplibre-gl";

// Bottom to top (spec 003 Display), with terra-draw's "td-" layers (the area outline) on top.
const SLOTS = ["aef-preview", "preview", "label-", "brush-hover", "td-"] as const;
export type Slot = (typeof SLOTS)[number];

/** The id of the lowest layer in a slot above `slot`, to insert before; undefined means the top. */
export function beforeSlot(map: MapLibreMap, slot: Slot): string | undefined {
  const above = SLOTS.slice(SLOTS.indexOf(slot) + 1);
  return map.getStyle().layers.find((l) => above.some((s) => l.id.startsWith(s)))?.id;
}
