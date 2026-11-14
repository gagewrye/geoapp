import { describe, expect, it } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { addBox, emptyBoxes } from "../../../src/core/boxes";
import { boxLayer } from "../../../src/map/boxLayer";
import { BRUSH_GRID } from "../helpers/fakeBrushMap";

// Spec 064 criterion 4: a drag sets only the edit source, filtering the edited box out of the boxes source by layer filter.
function fakeMap() {
  const data = new Map<string, unknown[]>(), sets: string[] = [], filters = new Map<string, unknown>(), layout = new Map<string, string>();
  const layers: { id: string }[] = [{ id: "label-0,0" }, { id: "smart-fill" }];
  const map = {
    getStyle: () => ({ layers }),
    addSource: (id: string) => { data.set(id, []); },
    getSource: (id: string) => (data.has(id) ? { setData: (d: { features: unknown[] }) => { sets.push(id); data.set(id, d.features); } } : undefined),
    addLayer: (l: { id: string; filter: unknown }, before?: string) => {
      const i = before ? layers.findIndex((x) => x.id === before) : layers.length;
      layers.splice(i, 0, { id: l.id });
      filters.set(l.id, l.filter);
    },
    setFilter: (id: string, f: unknown) => { filters.set(id, f); },
    setLayoutProperty: (id: string, _k: string, v: string) => { layout.set(id, v); },
    project: ([x, y]: [number, number]) => ({ x, y: -y }), // BRUSH_GRID: pixel edge (c, r) is lon c, lat -r
  };
  return { map: map as unknown as MapLibreMap, data, sets, filters, layers, layout };
}

describe("boxLayer", () => {
  const s = emptyBoxes();
  const a = addBox(s, { x0: 2, y0: 2, x1: 10, y1: 8 }, 1), b = addBox(s, { x0: 20, y0: 20, x1: 30, y1: 30 }, 2);

  it("adds its layers with the first box, between label- and smart, and draws the selected box's handles only when asked", () => {
    const t = fakeMap(), layer = boxLayer(t.map);
    layer.open(BRUSH_GRID);
    layer.show([], ["#f00", "#0f0"], null, true);
    expect(t.layers.length).toBe(2); // nothing to draw: no layers yet
    layer.show(s.boxes.values(), ["#f00", "#0f0"], a.id, false);
    expect(t.layers[0]!.id).toBe("label-0,0");
    expect(t.layers.at(-1)!.id).toBe("smart-fill");
    expect(t.layers.slice(1, -1).every((l) => l.id.startsWith("boxes-"))).toBe(true);
    expect(t.data.get("boxes")!.length).toBe(2);
    layer.show(s.boxes.values(), ["#f00", "#0f0"], a.id, true);
    expect(t.data.get("boxes")!.length).toBe(2 + 8);
  });

  it("during a drag only the edit source gets setData and the edited box is filtered out; the release sets the boxes source once", () => {
    const t = fakeMap(), layer = boxLayer(t.map);
    layer.open(BRUSH_GRID);
    layer.show(s.boxes.values(), ["#f00", "#0f0"], b.id, true);
    t.sets.length = 0;
    for (let dx = 1; dx <= 5; dx++) layer.edit({ x0: 20 + dx, y0: 20, x1: 30 + dx, y1: 30 }, "#0f0", b.id);
    expect(t.sets).toEqual(Array(5).fill("boxes-edit"));
    expect(t.data.get("boxes-edit")!.length).toBe(1 + 8);
    for (const p of ["fill", "casing", "line", "handle"]) expect(JSON.stringify(t.filters.get(`boxes-${p}`))).toContain(`["!=",["get","id"],${b.id}]`);
    expect(t.filters.get("boxes-edit-line")).toEqual(["==", ["geometry-type"], "Polygon"]);
    layer.edit(null, "");
    layer.show(s.boxes.values(), ["#f00", "#0f0"], b.id, true);
    expect(t.sets.filter((x) => x === "boxes")).toEqual(["boxes"]);
    expect(t.data.get("boxes-edit")).toEqual([]);
    expect(JSON.stringify(t.filters.get("boxes-line"))).not.toContain("!=");
  });

  it("visible(false) hides every box layer, and layers added later start hidden", () => {
    const t = fakeMap(), layer = boxLayer(t.map);
    layer.open(BRUSH_GRID);
    layer.visible(false);
    layer.show(s.boxes.values(), ["#f00"], null, false);
    layer.visible(false);
    expect([...t.layout.values()]).toEqual(Array(8).fill("none"));
    layer.visible(true);
    expect([...t.layout.values()]).toEqual(Array(8).fill("visible"));
  });

  it("handleAt finds a handle within 6 screen px, corners first", () => {
    const t = fakeMap(), layer = boxLayer(t.map);
    expect(layer.handleAt(a, 10, 8)).toBeNull(); // no raster yet
    layer.open(BRUSH_GRID);
    expect(layer.handleAt(a, 10, 8)).toBe("se");
    expect(layer.handleAt(a, 6, 2.5)).toBe("nw"); // 0.5 px from n, but 4 px from a corner
    expect(layer.handleAt({ x0: 0, y0: 0, x1: 20, y1: 20 }, 10, 1)).toBe("n");
    expect(layer.handleAt(a, 6, 20)).toBeNull();
  });
});
