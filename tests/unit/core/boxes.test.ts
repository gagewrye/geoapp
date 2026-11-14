import { describe, expect, it } from "vitest";
import {
  addBox, boxesAt, emptyBoxes, handlePoints, moveRect, rectFrom, removeBox, resizeRect, setBox, type Handle, type Rect,
} from "../../../src/core/boxes";

// Spec 063 criteria 1 to 5.
const dims = { width: 300, height: 200 };
const inside = (r: Rect, [c, row]: [number, number]) => r.x0 <= c && c < r.x1 && r.y0 <= row && row < r.y1;
const within = (r: Rect) => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= dims.width && r.y1 <= dims.height && r.x0 < r.x1 && r.y0 < r.y1;

/** Deterministic integers in [0, n) (an LCG), so failures replay. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

describe("rectFrom (criterion 1)", () => {
  it("gives the same box for both corner orders, covering both pixels", () => {
    const a: [number, number] = [40, 120], b: [number, number] = [10, 30];
    const r = rectFrom(a, b, dims)!;
    expect(r).toEqual({ x0: 10, y0: 30, x1: 41, y1: 121 });
    expect(rectFrom(b, a, dims)).toEqual(r);
    expect(rectFrom([40, 30], [10, 120], dims)).toEqual(r);
    expect(inside(r, a) && inside(r, b)).toBe(true);
    expect(rectFrom([5, 5], [5, 5], dims)).toEqual({ x0: 5, y0: 5, x1: 6, y1: 6 });
  });

  it("clips a box crossing the raster edge, and gives null for one wholly outside", () => {
    expect(rectFrom([-20, -5], [10, 10], dims)).toEqual({ x0: 0, y0: 0, x1: 11, y1: 11 });
    expect(rectFrom([290, 190], [400, 250], dims)).toEqual({ x0: 290, y0: 190, x1: 300, y1: 200 });
    expect(rectFrom([299, 199], [299, 199], dims)).toEqual({ x0: 299, y0: 199, x1: 300, y1: 200 });
    expect(rectFrom([300, 10], [350, 20], dims)).toBeNull();
    expect(rectFrom([-10, 10], [-1, 20], dims)).toBeNull();
    expect(rectFrom([10, 200], [20, 210], dims)).toBeNull();
    expect(rectFrom([10, -9], [20, -1], dims)).toBeNull();
  });
});

describe("moveRect (criterion 2)", () => {
  it("keeps the size and stays inside the raster over 500 random rects and moves; a move within bounds is exact", () => {
    const next = rng(63);
    let exact = 0;
    for (let i = 0; i < 500; i++) {
      const x0 = next(dims.width), y0 = next(dims.height);
      const r = { x0, y0, x1: x0 + 1 + next(dims.width - x0), y1: y0 + 1 + next(dims.height - y0) };
      const dx = next(700) - 350, dy = next(500) - 250;
      const m = moveRect(r, dx, dy, dims);
      expect([m.x1 - m.x0, m.y1 - m.y0]).toEqual([r.x1 - r.x0, r.y1 - r.y0]);
      expect(within(m)).toBe(true);
      if (within({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy })) {
        exact++;
        expect(m).toEqual({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });
      }
    }
    expect(exact).toBeGreaterThan(0);
  });

  it("returns a new rect and clamps each axis on its own", () => {
    const r = { x0: 10, y0: 10, x1: 20, y1: 30 };
    expect(moveRect(r, -50, 5, dims)).toEqual({ x0: 0, y0: 15, x1: 10, y1: 35 });
    expect(moveRect(r, 5, 500, dims)).toEqual({ x0: 15, y0: 180, x1: 25, y1: 200 });
    expect(r).toEqual({ x0: 10, y0: 10, x1: 20, y1: 30 });
  });
});

describe("resizeRect (criterion 3)", () => {
  const r = { x0: 100, y0: 50, x1: 150, y1: 90 };
  it("each of the 8 handles moves only its own edges", () => {
    const cell: [number, number] = [120, 70]; // inside r
    const want: Record<Handle, Rect> = {
      nw: { x0: 120, y0: 70, x1: 150, y1: 90 },
      n: { x0: 100, y0: 70, x1: 150, y1: 90 },
      ne: { x0: 100, y0: 70, x1: 121, y1: 90 },
      e: { x0: 100, y0: 50, x1: 121, y1: 90 },
      se: { x0: 100, y0: 50, x1: 121, y1: 71 },
      s: { x0: 100, y0: 50, x1: 150, y1: 71 },
      sw: { x0: 120, y0: 50, x1: 150, y1: 71 },
      w: { x0: 120, y0: 50, x1: 150, y1: 90 },
    };
    for (const h of Object.keys(want) as Handle[]) expect([h, resizeRect(r, h, cell, dims)]).toEqual([h, want[h]]);
    // outward too
    expect(resizeRect(r, "e", [200, 0], dims)).toEqual({ x0: 100, y0: 50, x1: 201, y1: 90 });
    expect(resizeRect(r, "n", [0, 10], dims)).toEqual({ x0: 100, y0: 10, x1: 150, y1: 90 });
  });

  it("crossing the opposite edge flips the box", () => {
    expect(resizeRect(r, "e", [80, 0], dims)).toEqual({ x0: 80, y0: 50, x1: 100, y1: 90 });
    expect(resizeRect(r, "w", [160, 0], dims)).toEqual({ x0: 150, y0: 50, x1: 161, y1: 90 });
    expect(resizeRect(r, "n", [0, 95], dims)).toEqual({ x0: 100, y0: 90, x1: 150, y1: 96 });
    expect(resizeRect(r, "s", [0, 20], dims)).toEqual({ x0: 100, y0: 20, x1: 150, y1: 50 });
    expect(resizeRect(r, "se", [90, 40], dims)).toEqual({ x0: 90, y0: 40, x1: 100, y1: 50 });
    expect(resizeRect(r, "nw", [160, 95], dims)).toEqual({ x0: 150, y0: 90, x1: 161, y1: 96 });
  });

  it("a 1 px box stays at least 1 px, and the result is clipped to the raster", () => {
    const one = { x0: 10, y0: 10, x1: 11, y1: 11 };
    for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]) {
      for (const cell of [[10, 10], [9, 9], [11, 11], [0, 0], [299, 199]] as [number, number][]) {
        const got = resizeRect(one, h, cell, dims);
        expect(got.x1 - got.x0).toBeGreaterThanOrEqual(1);
        expect(got.y1 - got.y0).toBeGreaterThanOrEqual(1);
      }
    }
    expect(resizeRect(one, "se", [10, 10], dims)).toEqual(one);
    expect(resizeRect(one, "nw", [10, 10], dims)).toEqual(one);
    expect(resizeRect(r, "se", [900, 900], dims)).toEqual({ x0: 100, y0: 50, x1: 300, y1: 200 });
    expect(resizeRect(r, "nw", [-40, -40], dims)).toEqual({ x0: 0, y0: 0, x1: 150, y1: 90 });
    expect(resizeRect(r, "e", [-40, 0], dims)).toEqual({ x0: 0, y0: 50, x1: 100, y1: 90 });
  });
});

describe("boxesAt (criterion 4)", () => {
  it("gives nested boxes smallest first; pixel x1 - 1 is inside and x1 outside", () => {
    const s = emptyBoxes();
    const big = addBox(s, { x0: 0, y0: 0, x1: 100, y1: 100 }, 1);
    const small = addBox(s, { x0: 10, y0: 10, x1: 20, y1: 20 }, 2);
    const mid = addBox(s, { x0: 5, y0: 5, x1: 50, y1: 50 }, 3);
    expect(boxesAt(s, 15, 15).map((b) => b.id)).toEqual([small.id, mid.id, big.id]);
    expect(boxesAt(s, 19, 19).map((b) => b.id)).toEqual([small.id, mid.id, big.id]);
    expect(boxesAt(s, 20, 15).map((b) => b.id)).toEqual([mid.id, big.id]);
    expect(boxesAt(s, 15, 20).map((b) => b.id)).toEqual([mid.id, big.id]);
    expect(boxesAt(s, 10, 10).map((b) => b.id)).toEqual([small.id, mid.id, big.id]);
    expect(boxesAt(s, 99, 0).map((b) => b.id)).toEqual([big.id]);
    expect(boxesAt(s, 100, 0)).toEqual([]);
  });

  it("gives the newer box first on a tie of area", () => {
    const s = emptyBoxes();
    const a = addBox(s, { x0: 0, y0: 0, x1: 10, y1: 10 }, 1);
    const b = addBox(s, { x0: 5, y0: 0, x1: 15, y1: 10 }, 1);
    const c = addBox(s, { x0: 0, y0: 0, x1: 10, y1: 10 }, 1);
    expect(boxesAt(s, 7, 5).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });
});

describe("store (criterion 5)", () => {
  it("ids increase and are not reused after a remove", () => {
    const s = emptyBoxes();
    const a = addBox(s, { x0: 0, y0: 0, x1: 1, y1: 1 }, 1);
    const b = addBox(s, { x0: 0, y0: 0, x1: 2, y1: 2 }, 1);
    expect(a.id).toBeGreaterThan(0);
    expect(b.id).toBeGreaterThan(a.id);
    removeBox(s, b.id);
    removeBox(s, a.id);
    const c = addBox(s, { x0: 0, y0: 0, x1: 3, y1: 3 }, 1);
    expect(c.id).toBeGreaterThan(b.id);
    expect([...s.boxes.keys()]).toEqual([c.id]);
  });

  it("addBox throws for value 0 or 256, and for an empty rect", () => {
    const s = emptyBoxes(), r = { x0: 0, y0: 0, x1: 4, y1: 4 };
    expect(() => addBox(s, r, 0)).toThrow();
    expect(() => addBox(s, r, 256)).toThrow();
    expect(() => addBox(s, r, 1.5)).toThrow();
    expect(() => addBox(s, { x0: 4, y0: 0, x1: 4, y1: 4 }, 1)).toThrow();
    expect(() => addBox(s, { x0: 0, y0: 5, x1: 4, y1: 4 }, 1)).toThrow();
    expect(s.boxes.size).toBe(0);
    expect(addBox(s, r, 255).value).toBe(255);
    expect(addBox(s, r, 1)).toEqual({ id: 2, value: 1, ...r });
  });

  it("iterates in insertion order; setBox replaces by id in place and copies; a box put back keeps its place", () => {
    const s = emptyBoxes();
    const r = { x0: 0, y0: 0, x1: 4, y1: 4 };
    const [a, b, c] = [addBox(s, r, 1), addBox(s, r, 2), addBox(s, r, 3)];
    const moved = { ...a, x0: 1, x1: 5 };
    setBox(s, moved);
    moved.x0 = 3;
    expect(s.boxes.get(a.id)).toEqual({ ...a, x0: 1, x1: 5 });
    expect([...s.boxes.keys()]).toEqual([a.id, b.id, c.id]);
    removeBox(s, b.id);
    setBox(s, b); // an undo of the remove
    expect([...s.boxes.keys()]).toEqual([a.id, b.id, c.id]);
    expect(s.next).toBe(c.id + 1);
  });
});

describe("handlePoints", () => {
  it("gives the 8 handles as pixel-edge points", () => {
    expect(handlePoints({ x0: 10, y0: 20, x1: 30, y1: 25 })).toEqual([
      { handle: "nw", x: 10, y: 20 }, { handle: "n", x: 20, y: 20 }, { handle: "ne", x: 30, y: 20 }, { handle: "e", x: 30, y: 22.5 },
      { handle: "se", x: 30, y: 25 }, { handle: "s", x: 20, y: 25 }, { handle: "sw", x: 10, y: 25 }, { handle: "w", x: 10, y: 22.5 },
    ]);
  });
});
