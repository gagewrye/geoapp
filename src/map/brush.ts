import { Point, type Map as MapLibreMap } from "maplibre-gl";
import type { Window } from "../core/grid";
import type { Erase } from "../core/labelStore";
import { footprint, footprintRing, pixelAt, strokeCellsIn } from "../core/pixel";
import type { Grid } from "../core/types";
import { brushCursor, eraserCursor } from "./cursor";
import { ERASE_COLOUR, showHover } from "./hover";

export type BrushMode = "paint" | "erase" | "pan" | "smart" | "fill" | "polygon" | "box";
type Deps = {
  side: () => number;
  colour: () => string;
  /** The stroke cells one pointer move reaches, in order, all on or overlapping the raster, with the brush side (spec 023 F6). */
  cells: (cells: [number, number][], side: number, erase: Erase) => void;
  /** The Paint hover's footprint, or null when none shows (spec 023 F3, F5). */
  hovered?: (w: Window | null) => void;
  /** A stroke began (before its first cells) or ended. */
  onStroke: (active: boolean) => void;
  /** A middle-button pan is in progress (spec 009): presses paint nothing. */
  panning: () => boolean;
  /** An Alt+left press on a raster cell, in any mode: pick its class instead of painting or panning (spec 038). */
  pick?: (cell: [number, number]) => void;
  /** Smart, Fill and Polygon modes (specs 046, 049, 054): a left (include) or Shift+left (exclude) click on a raster cell, pressed and released within 4 px. */
  click?: (cell: [number, number], include: boolean) => void;
  /** The same modes: a right click anywhere on the map canvas (spec 049 discards the selection; spec 054 steps a polygon back). */
  discard?: () => void;
};
type Stroke = { pointerId: number; erase: Erase; prev: [number, number] | null };

/** The paint brush on the map (spec 003, ADR 0009): mouse and pen paint and erase; touch never paints. */
// In Paint and Erase modes mouse and pen mousedowns never reach MapLibre, so drags don't move the map while touch
// still pans (dragPan.disable() would stop touch too); rotate, double-click and box zoom are off. Pan
// mode, or holding Space, gives MapLibre's defaults back and hides the footprint.
export function createBrush(map: MapLibreMap, deps: Deps) {
  const container = map.getCanvasContainer();
  let grid: Grid | null = null;
  let mode: BrushMode = "paint";
  let space = false;
  let stroke: Stroke | null = null;
  let locked = false; // while seeding (spec 004): no strokes and no footprint; Paint mode's handlers stay
  let blocked = false; // while peeking (spec 034): no stroke, fill or polygon corner starts, and the cursor shows locked; the footprint stays
  let lastType = "mouse";
  let pointer: { x: number; y: number; target: EventTarget | null } | null = null; // last mouse or pen position
  let press: { pointerId: number; button: number; shift: boolean; x: number; y: number } | null = null; // a click in progress
  const painting = () => grid !== null && (mode === "paint" || mode === "erase") && !space; // Paint or Erase (spec 033)
  const boxing = () => grid !== null && mode === "box" && !space; // drags draw boxes (map/boxTool.ts), so they don't pan either (spec 064)
  const clicking = () => grid !== null && (mode === "smart" || mode === "fill" || mode === "polygon") && !space; // these take clicks, and drags pan
  const shaping = () => clicking() && mode !== "smart"; // Fill or Polygon (spec 054): a crosshair, and a double click closes a polygon instead of zooming

  // The brush cursor (spec 010) is a class plus a variable, which style.css applies to the canvas over MapLibre's cursors.
  // Locked, a left drag neither paints nor pans, so neither the brush nor MapLibre's grab would be true.
  let cursor = "";
  const syncCursor = () => {
    container.classList.toggle("brush-cursor", painting() && !locked && !blocked);
    container.classList.toggle("locked-cursor", painting() && (locked || blocked));
    container.classList.toggle("click-cursor", shaping() || boxing());
    const c = mode === "erase" ? eraserCursor() : brushCursor(deps.colour());
    if (c !== cursor) container.style.setProperty("--brush-cursor", cursor = c);
  };

  // Only handlers the brush turned off are turned back on: MapLibre owns the rest (all of them in Pan and Smart)
  const handlers = [map.dragRotate, map.doubleClickZoom, map.boxZoom];
  let owned: typeof handlers = [];
  const syncHandlers = () => {
    const off = painting() || boxing() ? handlers : shaping() ? [map.doubleClickZoom] : [];
    for (const h of owned) if (!off.includes(h)) h.enable();
    for (const h of off) h.disable();
    owned = off;
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

  /** The pixel under a client point when it is on the raster itself, else null. */
  const rasterCell = (x: number, y: number, target: EventTarget | null): [number, number] | null => {
    const cell = cellAt(x, y, target);
    return cell && cell[0] >= 0 && cell[1] >= 0 && cell[0] < grid!.width && cell[1] < grid!.height ? cell : null;
  };
  const picks = (e: MouseEvent) => deps.pick !== undefined && e.altKey && e.button === 0 && rasterCell(e.clientX, e.clientY, e.target);

  // Hovering is synchronous and reads nothing: the ring covers the whole footprint, nodata included.
  const hover = () => {
    const cell = pointer && painting() && !locked ? cellAt(pointer.x, pointer.y, pointer.target) : null;
    const w = cell && footprint(grid!, cell[0], cell[1], deps.side());
    showHover(map, w ? footprintRing(grid!, w) : null, mode === "erase" ? ERASE_COLOUR : deps.colour(), mode === "erase");
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
    if (!stroke && !deps.panning() && picks(e)) { deps.pick!(rasterCell(e.clientX, e.clientY, e.target)!); return; }
    if (clicking() && !(blocked && shaping()) && !e.altKey && (e.button === 0 || e.button === 2)) press = { pointerId: e.pointerId, button: e.button, shift: e.shiftKey, x: e.clientX, y: e.clientY };
    if (!painting() || stroke || deps.panning() || (e.button !== 0 && e.button !== 2)) return;
    if (locked || blocked) return;
    // Erase mode removes any label; Paint's right or pen barrel drag removes the selected class only (spec 058)
    stroke = { pointerId: e.pointerId, erase: mode === "erase" ? "any" : e.button === 2, prev: null };
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
  window.addEventListener("pointerup", (e) => {
    if (stroke?.pointerId === e.pointerId) end();
    const p = press;
    if (p?.pointerId !== e.pointerId) return;
    press = null;
    if (!clicking() || e.button !== p.button || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return;
    if (p.button === 2) {
      if (e.target instanceof Node && container.contains(e.target)) deps.discard?.();
      return;
    }
    const cell = rasterCell(e.clientX, e.clientY, e.target);
    if (cell) deps.click?.(cell, !p.shift);
  });
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
    if (lastType === "touch" || !(e.target instanceof Node) || !container.contains(e.target)) return;
    if (painting() || boxing() || (grid && picks(e))) e.stopPropagation(); // an Alt pick doesn't pan in Pan mode either
    // Shift+left is a click (Smart's exclude point), not MapLibre's box zoom, which would zoom to a 1-4 px box (spec 049)
    else if (clicking() && e.button === 0 && e.shiftKey) e.stopPropagation();
  }, { capture: true });
  // Alt alone does nothing over the map; released there it mustn't hand focus to Firefox's menu bar (spec 038)
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && pointer?.target instanceof Node && container.contains(pointer.target)) e.preventDefault();
  });
  // Only on the map, which also covers a right release that fires contextmenu late (Windows); the panel
  // keeps its menu even just after an erase, so text fields keep copy and paste (spec 003 Strokes)
  map.getContainer().addEventListener("contextmenu", (e) => { if (grid) e.preventDefault(); });

  return {
    /** The local imagery's grid, or null when none is open (the brush is then inert). */
    setImagery(g: Grid | null): void { end(); grid = g; syncHandlers(); hover(); },
    /** Changing mode ends a stroke in progress (spec 016: hiding labels mid-stroke selects Pan). */
    setMode(m: BrushMode): void { if (m !== mode) end(); mode = m; syncHandlers(); hover(); },
    mode: () => mode,
    /** Box mode with a raster open and Space not held: left drags are the box tool's. */
    boxing,
    /** Space held acts as Pan. */
    setSpace(held: boolean): void { if (space !== held) { space = held; syncHandlers(); hover(); } },
    /** Locked, the brush neither paints nor shows its footprint; a stroke in progress ends. */
    setLocked(on: boolean): void { locked = on; if (on) end(); syncCursor(); hover(); },
    /** Blocked, no stroke starts (a peek hides the labels: spec 034); one in progress is left alone. */
    setBlocked(on: boolean): void { blocked = on; syncCursor(); },
    /** Redraw the footprint and cursor after a size or colour change. */
    refresh(): void { syncCursor(); hover(); },
    /** A stroke is in progress. */
    stroking: () => stroke !== null,
    /** The raster pixel under the last mouse or pen position over the map, or null (spec 038's I key). */
    hoverCell: (): [number, number] | null => (pointer && grid ? rasterCell(pointer.x, pointer.y, pointer.target) : null),
  };
}
