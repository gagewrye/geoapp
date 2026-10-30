import { Point, type Map as MapLibreMap } from "maplibre-gl";
import type { Window } from "../core/grid";
import { footprint, footprintRing, pixelAt, strokeCellsIn } from "../core/pixel";
import type { Grid } from "../core/types";
import { brushCursor } from "./cursor";
import { showHover } from "./hover";

export type BrushMode = "paint" | "pan";
type Deps = {
  side: () => number;
  colour: () => string;
  /** The stroke cells one pointer move reaches, in order, all on or overlapping the raster, with the brush side (spec 023 F6). */
  cells: (cells: [number, number][], side: number, erase: boolean) => void;
  /** The Paint hover's footprint, or null when none shows (spec 023 F3, F5). */
  hovered?: (w: Window | null) => void;
  /** A stroke began (before its first cells) or ended. */
  onStroke: (active: boolean) => void;
  /** A middle-button pan is in progress (spec 009): presses paint nothing. */
  panning: () => boolean;
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
  let locked = false; // while seeding (spec 004): no strokes and no footprint; Paint mode's handlers stay
  let lastType = "mouse";
  let pointer: { x: number; y: number; target: EventTarget | null } | null = null; // last mouse or pen position
  const painting = () => grid !== null && mode === "paint" && !space;

  // The brush cursor (spec 010) is a class plus a variable, which style.css applies to the canvas over MapLibre's cursors.
  // Locked, a left drag neither paints nor pans, so neither the brush nor MapLibre's grab would be true.
  let cursor = "";
  const syncCursor = () => {
    container.classList.toggle("brush-cursor", painting() && !locked);
    container.classList.toggle("locked-cursor", painting() && locked);
    const c = brushCursor(deps.colour());
    if (c !== cursor) container.style.setProperty("--brush-cursor", cursor = c);
  };

  // Only handlers the brush turned off are turned back on: outside Paint mode MapLibre owns them
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
    syncCursor();
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
    const cell = pointer && painting() && !locked ? cellAt(pointer.x, pointer.y, pointer.target) : null;
    const w = cell && footprint(grid!, cell[0], cell[1], deps.side());
    showHover(map, w ? footprintRing(grid!, w) : null, deps.colour());
    deps.hovered?.(w);
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
    const on = cells.filter(([c, r]) => footprint(grid!, c, r, side) !== null);
    if (on.length) deps.cells(on, side, s.erase);
  };

  const end = () => {
    if (!stroke) return;
    stroke = null;
    deps.onStroke(false);
  };

  container.addEventListener("pointerdown", (e) => {
    lastType = e.pointerType;
    if (e.pointerType === "touch") { pointer = null; hover(); return; }
    if (!painting() || stroke || deps.panning() || (e.button !== 0 && e.button !== 2)) return;
    if (locked) return;
    stroke = { pointerId: e.pointerId, erase: e.button === 2, prev: null };
    deps.onStroke(true);
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
  map.on("move", () => {
    // the map moved under the pointer (centre zoom, WASD): the next cell starts afresh, with no line across the jump
    if (stroke) stroke.prev = null;
    hover(); // and the footprint follows the pointer
  });

  // Capture on the map container runs before MapLibre's mousedown listener on the canvas container.
  map.getContainer().addEventListener("mousedown", (e) => {
    if (painting() && lastType !== "touch" && e.target instanceof Node && container.contains(e.target)) e.stopPropagation();
  }, { capture: true });
  // Only on the map, which also covers a right release that fires contextmenu late (Windows); the panel
  // keeps its menu even just after an erase, so text fields keep copy and paste (spec 003 Strokes)
  map.getContainer().addEventListener("contextmenu", (e) => { if (grid) e.preventDefault(); });

  return {
    /** The local imagery's grid, or null when none is open (the brush is then inert). */
    setImagery(g: Grid | null): void { end(); grid = g; syncHandlers(); hover(); },
    /** Leaving Paint ends a stroke in progress (spec 016: hiding labels mid-stroke selects Pan). */
    setMode(m: BrushMode): void { mode = m; if (m !== "paint") end(); syncHandlers(); hover(); },
    mode: () => mode,
    /** Space held acts as Pan. */
    setSpace(held: boolean): void { if (space !== held) { space = held; syncHandlers(); hover(); } },
    /** Locked, the brush neither paints nor shows its footprint; a stroke in progress ends. */
    setLocked(on: boolean): void { locked = on; if (on) end(); syncCursor(); hover(); },
    /** Redraw the footprint and cursor after a size or colour change. */
    refresh(): void { syncCursor(); hover(); },
    /** A stroke is in progress. */
    stroking: () => stroke !== null,
  };
}
