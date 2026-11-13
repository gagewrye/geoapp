import { describe, expect, it } from "vitest";
import {
  addBox, boxesAt, emptyBoxes, handlePoints, moveRect, rectFrom, removeBox, resizeRect, setBox, type Handle, type Rect,
} from "../../../src/core/boxes";

// Tester edge cases for spec 063's box geometry and store (criteria 1 to 5).
const dims = { width: 300, height: 200 };
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const valid = (r: Rect, d = dims) =>
  Number.isInteger(r.x0) && Number.isInteger(r.y0) && Number.isInteger(r.x1) && Number.isInteger(r.y1) &&
  r.x0 >= 0 && r.y0 >= 0 && r.x1 <= d.width && r.y1 <= d.height && r.x0 < r.x1 && r.y0 < r.y1;
const covers = (r: Rect, [c, row]: [number, number]) => r.x0 <= c && c < r.x1 && r.y0 <= row && row < r.y1;
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

describe("rectFrom edges (tester)", () => {
  it("a 1 x 1 raster gives its one pixel or null", () => {
    const one = { width: 1, height: 1 };
    expect(rectFrom([0, 0], [0, 0], one)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(rectFrom([-5, -5], [5, 5], one)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(rectFrom([1, 0], [1, 0], one)).toBeNull();
  });
  it("a 0 x 0 raster gives null", () => {
    expect(rectFrom([0, 0], [0, 0], { width: 0, height: 0 })).toBeNull();
  });
  it("outside on one axis only is null; spanning the whole raster clips to it", () => {
    expect(rectFrom([10, 250], [20, 260], dims)).toBeNull(); // x inside, y beyond
    expect(rectFrom([-1, -1], [300, 200], dims)).toEqual({ x0: 0, y0: 0, x1: 300, y1: 200 });
  });
  it("all 4 corner orders agree, and the result is valid and covers both in-raster pixels (random)", () => {
    const next = rng(7);
    for (let i = 0; i < 300; i++) {
      const a: [number, number] = [next(400) - 50, next(300) - 50], b: [number, number] = [next(400) - 50, next(300) - 50];
      const r = rectFrom(a, b, dims);
      expect(rectFrom(b, a, dims)).toEqual(r);
      expect(rectFrom([a[0], b[1]], [b[0], a[1]], dims)).toEqual(r);
      if (r) {
        expect(valid(r)).toBe(true);
        for (const p of [a, b]) if (p[0] >= 0 && p[0] < 300 && p[1] >= 0 && p[1] < 200) expect(covers(r, p)).toBe(true);
      }
    }
  });
});

describe("moveRect edges (tester)", () => {
  it("a box the size of the raster never moves", () => {
    const full = { x0: 0, y0: 0, x1: 300, y1: 200 };
    expect(moveRect(full, 50, -50, dims)).toEqual(full);
  });
  it("a move by (0, 0) returns an equal rect", () => {
    const r = { x0: 3, y0: 4, x1: 9, y1: 12 };
    expect(moveRect(r, 0, 0, dims)).toEqual(r);
  });
  it("a 1 px box at a corner clamps to the far corner", () => {
    expect(moveRect({ x0: 0, y0: 0, x1: 1, y1: 1 }, 1e6, 1e6, dims)).toEqual({ x0: 299, y0: 199, x1: 300, y1: 200 });
    expect(moveRect({ x0: 299, y0: 199, x1: 300, y1: 200 }, -1e6, -1e6, dims)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });
});

describe("resizeRect flips and bounds (tester)", () => {
  const r = { x0: 100, y0: 50, x1: 150, y1: 90 };
  it("dragging onto the pixel just past the fixed edge flips to a 1 px span there", () => {
    // w's fixed edge is x1 = 150: cell 150 is the first pixel past it
    expect(resizeRect(r, "w", [150, 0], dims)).toEqual({ x0: 150, y0: 50, x1: 151, y1: 90 });
    // e's fixed edge is x0 = 100: cell 99 is the first pixel before it
    expect(resizeRect(r, "e", [99, 0], dims)).toEqual({ x0: 99, y0: 50, x1: 100, y1: 90 });
    expect(resizeRect(r, "n", [0, 90], dims)).toEqual({ x0: 100, y0: 90, x1: 150, y1: 91 });
    expect(resizeRect(r, "s", [0, 49], dims)).toEqual({ x0: 100, y0: 49, x1: 150, y1: 50 });
  });
  it("dragging onto the fixed edge's own pixel collapses to 1 px, not 0", () => {
    expect(resizeRect(r, "w", [149, 0], dims)).toEqual({ x0: 149, y0: 50, x1: 150, y1: 90 });
    expect(resizeRect(r, "e", [100, 0], dims)).toEqual({ x0: 100, y0: 50, x1: 101, y1: 90 });
    expect(resizeRect(r, "n", [0, 89], dims)).toEqual({ x0: 100, y0: 89, x1: 150, y1: 90 });
    expect(resizeRect(r, "s", [0, 50], dims)).toEqual({ x0: 100, y0: 50, x1: 150, y1: 51 });
  });
  it("a corner can flip on one axis only", () => {
    expect(resizeRect(r, "ne", [80, 60], dims)).toEqual({ x0: 80, y0: 60, x1: 100, y1: 90 });
    expect(resizeRect(r, "sw", [120, 30], dims)).toEqual({ x0: 120, y0: 30, x1: 150, y1: 50 });
  });
  it("edge handles ignore the other axis of cell, even far outside the raster", () => {
    expect(resizeRect(r, "e", [120, -1000], dims)).toEqual({ x0: 100, y0: 50, x1: 121, y1: 90 });
    expect(resizeRect(r, "s", [-1000, 70], dims)).toEqual({ x0: 100, y0: 50, x1: 150, y1: 71 });
  });
  it("does not mutate its input", () => {
    const copy = { ...r };
    for (const h of HANDLES) resizeRect(r, h, [0, 0], dims);
    expect(r).toEqual(copy);
  });
  it("random rects, handles and cells always give a valid rect that covers the clamped cell on the moved axes", () => {
    const next = rng(11);
    for (let i = 0; i < 2000; i++) {
      const x0 = next(300), y0 = next(200);
      const box = { x0, y0, x1: x0 + 1 + next(300 - x0), y1: y0 + 1 + next(200 - y0) };
      const h = HANDLES[next(8)]!, cell: [number, number] = [next(500) - 100, next(400) - 100];
      const got = resizeRect(box, h, cell, dims);
      expect(valid(got)).toBe(true);
      const cc = Math.min(299, Math.max(0, cell[0])), cr = Math.min(199, Math.max(0, cell[1]));
      if (/[ew]/.test(h)) expect(got.x0 <= cc && cc < got.x1).toBe(true);
      else expect([got.x0, got.x1]).toEqual([box.x0, box.x1]);
      if (/[ns]/.test(h)) expect(got.y0 <= cr && cr < got.y1).toBe(true);
      else expect([got.y0, got.y1]).toEqual([box.y0, box.y1]);
    }
  });
});

describe("boxesAt edges (tester)", () => {
  it("an empty store and a pixel outside every box give []", () => {
    expect(boxesAt(emptyBoxes(), 0, 0)).toEqual([]);
    const s = emptyBoxes();
    addBox(s, { x0: 5, y0: 5, x1: 10, y1: 10 }, 1);
    expect(boxesAt(s, 4, 5)).toEqual([]);
    expect(boxesAt(s, 5, 4)).toEqual([]);
    expect(boxesAt(s, 5, 10)).toEqual([]);
    expect(boxesAt(s, -1, -1)).toEqual([]);
  });
  it("x0 and y0 are inside, y1 is outside", () => {
    const s = emptyBoxes(), b = addBox(s, { x0: 5, y0: 5, x1: 10, y1: 10 }, 1);
    expect(boxesAt(s, 5, 5).map((x) => x.id)).toEqual([b.id]);
    expect(boxesAt(s, 9, 9).map((x) => x.id)).toEqual([b.id]);
    expect(boxesAt(s, 9, 10)).toEqual([]);
  });
  it("order is by area then id, whatever the insertion order (a box put back by setBox)", () => {
    const s = emptyBoxes();
    const big = addBox(s, { x0: 0, y0: 0, x1: 50, y1: 50 }, 1);
    const tieA = addBox(s, { x0: 0, y0: 0, x1: 10, y1: 10 }, 1);
    const tieB = addBox(s, { x0: 0, y0: 0, x1: 5, y1: 20 }, 1); // same area as tieA, newer
    removeBox(s, tieA.id);
    setBox(s, tieA);
    removeBox(s, big.id);
    setBox(s, big);
    expect(boxesAt(s, 2, 2).map((x) => x.id)).toEqual([tieB.id, tieA.id, big.id]);
  });
  it("a moved box is found at its new place only", () => {
    const s = emptyBoxes(), b = addBox(s, { x0: 0, y0: 0, x1: 2, y1: 2 }, 1);
    setBox(s, { ...b, ...moveRect(b, 10, 10, dims) });
    expect(boxesAt(s, 0, 0)).toEqual([]);
    expect(boxesAt(s, 11, 11).map((x) => x.id)).toEqual([b.id]);
  });
});

describe("handlePoints edges (tester)", () => {
  it("a 1 x 1 box puts mid-edge handles on half pixels and corners on its edges", () => {
    const p = Object.fromEntries(handlePoints({ x0: 0, y0: 0, x1: 1, y1: 1 }).map((h) => [h.handle, [h.x, h.y]]));
    expect(p).toEqual({ nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] });
  });
  it("names all 8 handles once, in order", () => {
    expect(handlePoints({ x0: 0, y0: 0, x1: 300, y1: 200 }).map((h) => h.handle)).toEqual(HANDLES);
  });
  it("resizing by a handle onto the cell just inside its own point leaves the box unchanged", () => {
    const r = { x0: 10, y0: 20, x1: 30, y1: 40 };
    for (const { handle, x, y } of handlePoints(r)) {
      // the pixel touching the handle point from inside the box
      const cell: [number, number] = [handle.includes("e") ? x - 1 : Math.floor(x), handle.includes("s") ? y - 1 : Math.floor(y)];
      expect([handle, resizeRect(r, handle, cell, dims)]).toEqual([handle, r]);
    }
  });
});

describe("store edges (tester)", () => {
  it("addBox stores a copy: mutating the input rect or the returned box leaves the store alone", () => {
    const s = emptyBoxes(), rect = { x0: 0, y0: 0, x1: 3, y1: 3 };
    const b = addBox(s, rect, 4);
    rect.x0 = 2; b.x1 = 99;
    expect(s.boxes.get(b.id)).toEqual({ id: b.id, value: 4, x0: 0, y0: 0, x1: 3, y1: 3 });
  });
  it("addBox rejects NaN, negative and non-integer values; accepts 1 and 255", () => {
    const s = emptyBoxes(), r = { x0: 0, y0: 0, x1: 1, y1: 1 };
    for (const v of [NaN, -1, 0, 256, 1.5, Infinity]) expect(() => addBox(s, r, v)).toThrow();
    expect(s.next).toBe(1); // a throw uses no id
    expect(addBox(s, r, 1).id).toBe(1);
    expect(addBox(s, r, 255).id).toBe(2);
  });
  it("addBox rejects inverted and NaN rects", () => {
    const s = emptyBoxes();
    expect(() => addBox(s, { x0: 5, y0: 0, x1: 4, y1: 4 }, 1)).toThrow();
    expect(() => addBox(s, { x0: NaN, y0: 0, x1: 4, y1: 4 }, 1)).toThrow();
    expect(s.boxes.size).toBe(0);
  });
  it("removeBox of an absent id is a no-op; ids keep rising after removing everything", () => {
    const s = emptyBoxes(), r = { x0: 0, y0: 0, x1: 1, y1: 1 };
    removeBox(s, 42);
    const ids = [addBox(s, r, 1).id, addBox(s, r, 1).id, addBox(s, r, 1).id];
    ids.forEach((id) => removeBox(s, id));
    expect(addBox(s, r, 1).id).toBe(4);
  });
  it("setBox of the first of several removed boxes restores id order", () => {
    const s = emptyBoxes(), r = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const [a, b, c, d] = [addBox(s, r, 1), addBox(s, r, 1), addBox(s, r, 1), addBox(s, r, 1)];
    removeBox(s, a.id); removeBox(s, c.id);
    setBox(s, c);
    expect([...s.boxes.keys()]).toEqual([b.id, c.id, d.id]);
    setBox(s, a);
    expect([...s.boxes.keys()]).toEqual([a.id, b.id, c.id, d.id]);
  });
});
