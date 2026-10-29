import { describe, expect, it } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { applyLabelView, DEFAULT_LABEL_OPACITY, labelViewProps } from "../../../src/map/layers";

// Spec 016 Interfaces: applyLabelView sets raster-opacity and visibility on "label-…" layers and "mask" only.
function fakeMap(ids: string[]) {
  const set: string[] = [];
  const map = {
    getLayersOrder: () => ids,
    setPaintProperty: (id: string, k: string, v: unknown) => set.push(`${id} ${k} ${v}`),
    setLayoutProperty: (id: string, k: string, v: unknown) => set.push(`${id} ${k} ${v}`),
  };
  return { map: map as unknown as MapLibreMap, set };
}

describe("label view", () => {
  it("defaults to opacity 0.6, shown", () => {
    expect(DEFAULT_LABEL_OPACITY).toBe(0.6);
    expect(labelViewProps(fakeMap([]).map)).toEqual({ paint: { "raster-opacity": 0.6 }, layout: { visibility: "visible" } });
  });
  it("sets every label overlay and the mask, and nothing else", () => {
    const { map, set } = fakeMap(["basemap", "preview", "mask", "label-0,0", "label-256,0", "brush-hover-fill"]);
    applyLabelView(map, { opacity: 0.3, visible: false });
    expect(set).toEqual([
      "mask raster-opacity 0.3", "mask visibility none",
      "label-0,0 raster-opacity 0.3", "label-0,0 visibility none",
      "label-256,0 raster-opacity 0.3", "label-256,0 visibility none",
    ]);
  });
  it("gives layers added later the view last applied to that map", () => {
    const a = fakeMap([]), b = fakeMap([]);
    applyLabelView(a.map, { opacity: 0.25, visible: false });
    expect(labelViewProps(a.map)).toEqual({ paint: { "raster-opacity": 0.25 }, layout: { visibility: "none" } });
    expect(labelViewProps(b.map).paint["raster-opacity"]).toBe(0.6);
    applyLabelView(a.map, { opacity: 1, visible: true });
    expect(labelViewProps(a.map)).toEqual({ paint: { "raster-opacity": 1 }, layout: { visibility: "visible" } });
  });
});
