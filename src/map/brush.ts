import { Point, type Map as MapLibreMap } from "maplibre-gl";
import type { Window } from "../core/grid";
import { footprint, footprintRing, pixelAt, strokeCellsIn } from "../core/pixel";
import type { Grid } from "../core/types";
import { showHover } from "./hover";

export type BrushMode = "paint" | "pan";
type Deps = {
  side: () => number;
  colour: () => string;
  /** Footprints of the stroke cells one pointer position reaches, in order. */
  cells: (ws: Window[], erase: boolean) => void;
};
type Stroke = { pointerId: number; erase: boolean; prev: [number, number] | null };

/** The paint brush on the map (spec 003, ADR 0009): mouse and pen paint and erase; touch never paints. */
// In Paint mode mouse and pen mousedowns never reach MapLibre, so drags don't move the map while touch
// still pans (dragPan.disable() would stop touch too); rotate, double-click and box zoom are off. Pan
// mode, or holding Space, gives MapLibre's defaults back and hides the footprint.
export function createBrush(map: MapLibreMap, deps: Deps) {
  const container = map.getCanvasContainer();
  let grid: Grid | null = null;
  let mode: BrushMode = "paint";
  let space = false;
  let stroke: Stroke | null = null;
  let lastType = "mouse";
  let pointer: { x: number; y: number; target: EventTarget | null } | null = null; // last mouse or pen position
  const painting = () => grid !== null && mode === "paint" && !space;

  // Only handlers the brush turned off are turned back on: outside Paint mode terra-draw and MapLibre own them
  const handlers = [map.dragRotate, map.doubleClickZoom, map.boxZoom];
  let owned = false;
  const syncHandlers = () => {
    if (painting()) {
      for (const h of handlers) h.disable();
      owned = true;
    } else if (owned) {
      for (const h of handlers) h.enable();
      owned = false;
    }
  };

  /** The raster pixel under a client point, or null off the map canvas or off the globe. */
  const cellAt = (x: number, y: number, target: EventTarget | null): [number, number] | null => {
    if (!grid || !(target instanceof Node) || !container.contains(target)) return null;
    const r = map.getCanvas().getBoundingClientRect();
    const p = new Point(x - r.left, y - r.top);
    // maplibre-gl 6.16 keeps the transform on its camera; the sky around the globe isn't map surface
    if (p.x < 0 || p.y < 0 || p.x >= r.width || p.y >= r.height || !map._camera.transform.isPointOnMapSurface(p)) return null;
    const { lng, lat } = map.unproject(p);
    const cell = pixelAt(grid, lng, lat);
    return Number.isFinite(cell[0]) && Number.isFinite(cell[1]) ? cell : null;
  };

  // Hovering is synchronous and reads nothing: the ring covers the whole footprint, nodata included.
  const hover = () => {
    const cell = pointer && painting() ? cellAt(pointer.x, pointer.y, pointer.target) : null;
    const w = cell && footprint(grid!, cell[0], cell[1], deps.side());
    showHover(map, w ? footprintRing(grid!, w) : null, deps.colour());
  };

  const apply = (s: Stroke, e: PointerEvent) => {
    const cell = cellAt(e.clientX, e.clientY, e.target);
    if (!cell) { s.prev = null; return; } // lifted: no interpolation across the gap
    const prev = s.prev;
    if (prev && prev[0] === cell[0] && prev[1] === cell[1]) return;
    s.prev = cell;
    const side = deps.side(), h = (side - 1) / 2;
    // only cells whose footprint can meet the raster; the previous cell was applied already
    const box = { x0: -h, y0: -h, x1: grid!.width - 1 + h, y1: grid!.height - 1 + h };
    const cells = prev ? strokeCellsIn(prev, cell, box).filter(([c, r]) => c !== prev[0] || r !== prev[1]) : [cell];
    const ws: Window[] = [];
    for (const [c, r] of cells) { const w = footprint(grid!, c, r, side); if (w) ws.push(w); }
    if (ws.length) deps.cells(ws, s.erase);
  };

  const end = () => { stroke = null; };

  container.addEventListener("pointerdown", (e) => {
    lastType = e.pointerType;
    if (e.pointerType === "touch") { pointer = null; hover(); return; }
    if (!painting() || stroke || (e.button !== 0 && e.button !== 2)) return;
    stroke = { pointerId: e.pointerId, erase: e.button === 2, prev: null };
    apply(stroke, e);
  });
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    pointer = { x: e.clientX, y: e.clientY, target: e.target };
    if (stroke && e.pointerId === stroke.pointerId) {
      if (e.buttons === 0) end(); // the release was lost
      else apply(stroke, e);
    }
    hover();
  });
  window.addEventListener("pointerup", (e) => { if (stroke?.pointerId === e.pointerId) end(); });
  window.addEventListener("pointercancel", (e) => { if (stroke?.pointerId === e.pointerId) end(); });
  window.addEventListener("blur", () => { end(); space = false; syncHandlers(); pointer = null; hover(); });
  container.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") { pointer = null; hover(); } });
  map.on("move", hover); // wheel and keyboard zoom keep the footprint under the pointer

  // Capture on the map container runs before MapLibre's mousedown listener on the canvas container.
  map.getContainer().addEventListener("mousedown", (e) => {
    if (painting() && lastType !== "touch" && e.target instanceof Node && container.contains(e.target)) e.stopPropagation();
  }, { capture: true });
  // Only on the map, which also covers a right release that fires contextmenu late (Windows); the panel
  // keeps its menu even just after an erase, so text fields keep copy and paste (spec 003 [C3], Gage)
  map.getContainer().addEventListener("contextmenu", (e) => { if (grid) e.preventDefault(); });

  return {
    /** The local imagery's grid, or null when none is open (the brush is then inert). */
    setImagery(g: Grid | null): void { end(); grid = g; syncHandlers(); hover(); },
    setMode(m: BrushMode): void { mode = m; syncHandlers(); hover(); },
    mode: () => mode,
    /** Re-apply the mode's MapLibre handler state after something else changed it. */
    syncHandlers,
    /** Space held acts as Pan. */
    setSpace(held: boolean): void { if (space !== held) { space = held; syncHandlers(); hover(); } },
    /** Redraw the footprint after a size or colour change. */
    refresh: hover,
  };
}
