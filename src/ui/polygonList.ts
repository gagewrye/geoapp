import type { TerraDraw } from "terra-draw";

/** Editable list of drawn polygons: class name per polygon, and delete. */
export function renderPolygonList(list: HTMLElement, draw: TerraDraw): void {
  list.replaceChildren();
  for (const f of draw.getSnapshot()) {
    // the AlphaEarth area is a rectangle-mode polygon, not a label
    if (f.geometry.type !== "Polygon" || f.id === undefined || f.properties.mode !== "polygon") continue;
    const id = f.id;
    const li = document.createElement("li");
    li.dataset.featureId = String(id);
    const name = document.createElement("input");
    name.className = "polygon-class";
    name.value = String(f.properties.className ?? "");
    name.addEventListener("change", () => draw.updateFeatureProperties(id, { className: name.value.trim() }));
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", () => draw.removeFeatures([id]));
    li.append(name, del);
    list.append(li);
  }
}
