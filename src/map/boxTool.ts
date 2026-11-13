import type { Map as MapLibreMap } from "maplibre-gl";
import type { Handle, Rect } from "../core/boxes";
import { pixelAt } from "../core/pixel";
import type { Grid } from "../core/types";

type Cell = [number, number];
/** What a drag does, fixed at its press: draw a new box from a pixel, move the selected box, or resize it by a handle. */
export type BoxGesture = { kind: "draw" | "move"; from: Cell } | { kind: "resize"; handle: Handle; from: Cell };

type Deps = {
  /** Box mode with a raster open and Space not held (brush.boxing), and no middle-button pan (spec 009). */
  active: () => boolean;
  grid: () => Grid | null;
  /** The selected box, which a press near its handles resizes and one inside it moves. */
  selected: () => Rect | null;
  /** The handle of r within 6 px of canvas point (x, y) (boxLayer.handleAt). */
  handleAt: (r: Rect, x: number, y: number) => Handle | null;
  /** A drag began (once past 4 px), moved to a pixel clamped to the raster, ended there, or was lost. */
  start: (g: BoxGesture) => void;
  drag: (cell: Cell) => void;
  end: (cell: Cell) => void;
  cancel: () => void;
  /** A press and release within 4 px on the raster. */
  click: (cell: Cell) => void;
};
type Press = { pointerId: number; x: number; y: number; gesture: BoxGesture; cell: Cell; onRaster: boolean; dragging: boolean };

const CLICK_PX = 4;
const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));

/** Box mode's pointer input (spec 064): mouse and pen left drags draw, move or resize a box, and clicks select one; touch, Alt and other buttons are left to the map and the brush. */
// The brush keeps MapLibre from seeing Box mode's mousedowns and turns its drag handlers off (brush.boxing).
export function createBoxTool(map: MapLibreMap, d: Deps) {
  const container = map.getCanvasContainer();
  let press: Press | null = null;

  /** The canvas point under a client point, whether it is on the canvas, and its raster pixel: maybe off the raster, and null off the globe. */
  const at = (e: PointerEvent) => {
    const r = map.getCanvas().getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const { lng, lat } = map.unproject([x, y]);
    const cell = pixelAt(d.grid()!, lng, lat);
    return { x, y, on: x >= 0 && y >= 0 && x < r.width && y < r.height, cell: Number.isFinite(cell[0]) && Number.isFinite(cell[1]) ? cell : null };
  };
  const inside = (r: Rect, [c, row]: Cell) => r.x0 <= c && c < r.x1 && r.y0 <= row && row < r.y1;

  container.addEventListener("pointerdown", (e) => {
    if (press || e.pointerType === "touch" || e.button !== 0 || e.altKey || !d.active() || !d.grid()) return;
    const g = d.grid()!, { x, y, on, cell } = at(e);
    if (!cell || !on) return;
    const onRaster = cell[0] >= 0 && cell[1] >= 0 && cell[0] < g.width && cell[1] < g.height;
    const clamped: Cell = [clamp(cell[0], g.width - 1), clamp(cell[1], g.height - 1)];
    const sel = d.selected(), handle = sel && d.handleAt(sel, x, y);
    // a handle wins over the inside, so a small box can still be resized
    const gesture: BoxGesture | null = handle ? { kind: "resize", handle, from: clamped }
      : sel && onRaster && inside(sel, cell) ? { kind: "move", from: clamped } : onRaster ? { kind: "draw", from: clamped } : null;
    if (gesture) press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, gesture, cell: clamped, onRaster, dragging: false };
  });

  /** Follows the pointer: past 4 px the press becomes a drag; off the raster its pixel clamps to the edge, and off the globe it stays. */
  const follow = (p: Press, e: PointerEvent) => {
    if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_PX) { p.dragging = true; d.start(p.gesture); }
    const g = d.grid(), cell = g && at(e).cell;
    if (g && cell) p.cell = [clamp(cell[0], g.width - 1), clamp(cell[1], g.height - 1)];
    if (p.dragging) d.drag(p.cell);
  };
  const finish = (e: PointerEvent) => {
    const p = press!;
    press = null;
    follow(p, e);
    if (p.dragging) d.end(p.cell);
    else if (p.onRaster) d.click(p.gesture.from);
  };
  window.addEventListener("pointermove", (e) => {
    if (press?.pointerId !== e.pointerId) return;
    if (e.buttons === 0) finish(e); // the release was lost
    else follow(press, e);
  });
  window.addEventListener("pointerup", (e) => { if (press?.pointerId === e.pointerId) finish(e); });
  const lose = () => { if (press?.dragging) d.cancel(); press = null; };
  window.addEventListener("pointercancel", (e) => { if (press?.pointerId === e.pointerId) lose(); });
  window.addEventListener("blur", lose);

  return {
    /** A press or drag is in progress. */
    pressed: () => press !== null,
  };
}
