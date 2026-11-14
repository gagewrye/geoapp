/** Pixel edges: the rect covers pixels x0..x1-1 and y0..y1-1 (spec 063). */
export type Rect = { x0: number; y0: number; x1: number; y1: number };
/** value: class index + 1 (1..255), as in tiles. */
export type Box = Rect & { id: number; value: number };
/** Boxes by id, in insertion order; next is the id the next addBox gets. */
export type BoxStore = { boxes: Map<number, Box>; next: number };
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Dims = { width: number; height: number };

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function emptyBoxes(): BoxStore { return { boxes: new Map(), next: 1 }; }

/** Pixel (col, row) lies in r: x0 <= col < x1 and y0 <= row < y1. */
export const contains = (r: Rect, col: number, row: number) => r.x0 <= col && col < r.x1 && r.y0 <= row && row < r.y1;

/** The raster pixel nearest cell ([col, row]): each coordinate clamped to 0..width-1 or 0..height-1 (spec 064). */
export const clampCell = (cell: [number, number], dims: Dims): [number, number] =>
  [clamp(cell[0], 0, dims.width - 1), clamp(cell[1], 0, dims.height - 1)];

/** Adds a copy of r with a new id; throws for a value outside 1..255 or an empty rect. */
export function addBox(s: BoxStore, r: Rect, value: number): Box {
  if (!Number.isInteger(value) || value < 1 || value > 255) throw new RangeError(`box value ${value} is outside 1..255`);
  if (!(r.x1 > r.x0 && r.y1 > r.y0)) throw new RangeError("box rect is empty");
  const b: Box = { id: s.next++, value, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
  s.boxes.set(b.id, b);
  return { ...b };
}

/** Replaces the box with b's id by a copy of b, or puts it back in id order if absent (an undone remove). */
export function setBox(s: BoxStore, b: Box): void {
  const copy = { ...b };
  s.next = Math.max(s.next, b.id + 1);
  if (s.boxes.has(b.id) || [...s.boxes.keys()].every((id) => id < b.id)) { s.boxes.set(b.id, copy); return; }
  // ids are given in insertion order, so a box put back keeps its old place in the iteration order
  const all = [...s.boxes.values(), copy].sort((p, q) => p.id - q.id);
  s.boxes.clear();
  for (const x of all) s.boxes.set(x.id, x);
}

export function removeBox(s: BoxStore, id: number): void { s.boxes.delete(id); }

/** The box covering pixels a and b ([col, row]) inclusive, clipped to the raster; null when wholly outside. */
export function rectFrom(a: [number, number], b: [number, number], dims: Dims): Rect | null {
  const x0 = Math.max(0, Math.min(a[0], b[0])), x1 = Math.min(dims.width, Math.max(a[0], b[0]) + 1);
  const y0 = Math.max(0, Math.min(a[1], b[1])), y1 = Math.min(dims.height, Math.max(a[1], b[1]) + 1);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** r moved by (dx, dy), its size kept, clamped inside the raster. */
export function moveRect(r: Rect, dx: number, dy: number, dims: Dims): Rect {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const x0 = clamp(r.x0 + dx, 0, dims.width - w), y0 = clamp(r.y0 + dy, 0, dims.height - h);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/** One axis: the edge opposite the dragged one stays, and the dragged one moves to cover c, past the fixed edge if need be. */
function span(fixed: number, c: number): [number, number] {
  return c >= fixed ? [fixed, c + 1] : [c, fixed];
}

/** r with the handle's edges moved to cover cell ([col, row]), clipped to the raster; flips past the opposite edge, at least 1 x 1. */
export function resizeRect(r: Rect, handle: Handle, cell: [number, number], dims: Dims): Rect {
  const c = clamp(cell[0], 0, dims.width - 1), row = clamp(cell[1], 0, dims.height - 1);
  let { x0, y0, x1, y1 } = r;
  if (handle.includes("e")) [x0, x1] = span(r.x0, c);
  if (handle.includes("w")) [x0, x1] = span(r.x1, c);
  if (handle.includes("s")) [y0, y1] = span(r.y0, row);
  if (handle.includes("n")) [y0, y1] = span(r.y1, row);
  return { x0, y0, x1, y1 };
}

const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);

/** The boxes containing pixel (col, row): smallest area first, newest first on a tie. */
export function boxesAt(s: BoxStore, col: number, row: number): Box[] {
  const hit = [...s.boxes.values()].filter((b) => contains(b, col, row));
  return hit.sort((a, b) => area(a) - area(b) || b.id - a.id);
}

/** The 8 handles as pixel-edge points, nw first, clockwise. */
export function handlePoints(r: Rect): { handle: Handle; x: number; y: number }[] {
  const mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
  const at = (h: Handle) => ({
    handle: h,
    x: h.includes("w") ? r.x0 : h.includes("e") ? r.x1 : mx,
    y: h.includes("n") ? r.y0 : h.includes("s") ? r.y1 : my,
  });
  return HANDLES.map(at);
}

/** The handle within radius screen px of (x, y): the nearest corner if any is in reach, else the nearest edge (spec 064). */
export function handleNear(points: { handle: Handle; x: number; y: number }[], x: number, y: number, radius = 6): Handle | null {
  for (const corner of [true, false]) {
    let best: Handle | null = null, bestD = Infinity;
    for (const p of points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if ((p.handle.length === 2) === corner && d <= radius && d < bestD) { best = p.handle; bestD = d; }
    }
    if (best) return best;
  }
  return null;
}

/** The id a click selects among hits (boxesAt): the one after selected when the click repeats on the same pixel, else the first; null for none. */
export function cycleBox(hits: Box[], selected: number | null, again: boolean): number | null {
  if (!hits.length) return null;
  const i = again ? hits.findIndex((b) => b.id === selected) : -1;
  return hits[(i + 1) % hits.length]!.id;
}
