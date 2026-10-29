import type { Map as MapLibreMap } from "maplibre-gl";

// Bottom to top (spec 012 Rendering, spec 003 Display, spec 014 Display).
const SLOTS = ["basemap", "preview", "mask", "label-", "brush-hover"] as const;

export type Slot = (typeof SLOTS)[number];

/** The id of the lowest layer in a slot above `slot`, to insert before; undefined means the top. */
export function beforeSlot(map: MapLibreMap, slot: Slot): string | undefined {
  const above = SLOTS.slice(SLOTS.indexOf(slot) + 1);
  return map.getStyle().layers.find((l) => above.some((s) => l.id.startsWith(s)))?.id;
}

/** How the label overlays and the mask show (spec 016): opacity 0..1, and whether they show at all. */
export type LabelView = { opacity: number; visible: boolean };

/** The Opacity slider's default, for the overlays and the mask alike. */
export const DEFAULT_LABEL_OPACITY = 0.6;

// Per map, so layers created later (a new tile, Undo, an import) start with the view the user chose.
const views = new WeakMap<MapLibreMap, LabelView>();
const isLabelLayer = (id: string) => id.startsWith("label-") || id === "mask";

/** The current view's paint and layout properties, for a label overlay or mask layer being added. */
export function labelViewProps(map: MapLibreMap) {
  const v = views.get(map) ?? { opacity: DEFAULT_LABEL_OPACITY, visible: true };
  return { paint: { "raster-opacity": v.opacity }, layout: { visibility: v.visible ? "visible" as const : "none" as const } };
}

/** Sets raster-opacity and visibility on every label overlay ("label-…") and on "mask", now and for layers added later. */
export function applyLabelView(map: MapLibreMap, view: LabelView): void {
  views.set(map, { ...view });
  const { paint, layout } = labelViewProps(map);
  for (const id of map.getLayersOrder()) { // ids only: getStyle() would copy every layer on each slider tick
    if (!isLabelLayer(id)) continue;
    map.setPaintProperty(id, "raster-opacity", paint["raster-opacity"]);
    map.setLayoutProperty(id, "visibility", layout.visibility);
  }
}
