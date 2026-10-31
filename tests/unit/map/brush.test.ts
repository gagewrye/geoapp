import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrush, type BrushMode } from "../../../src/map/brush";
import { BRUSH_GRID, fakeBrushMap } from "../helpers/fakeBrushMap";

vi.mock("maplibre-gl", () => ({ Point: class { constructor(readonly x: number, readonly y: number) {} } }));
vi.mock("../../../src/map/hover", () => ({ showHover: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); });

function setup(mode: BrushMode, onStroke: (active: boolean) => void = () => {}) {
  const { map, pointer } = fakeBrushMap(vi.stubGlobal);
  const calls: boolean[] = [];
  const brush = createBrush(map, {
    side: () => 1, colour: () => "#ff0000", cells: (_c, _s, erase) => { calls.push(erase); }, onStroke: (a) => onStroke(a), panning: () => false,
  });
  brush.setImagery(BRUSH_GRID);
  brush.setMode(mode);
  return { brush, pointer, calls };
}

// Spec 033 criterion 1.
describe("brush modes", () => {
  it("in Erase mode a left press erases, and so does a right press", () => {
    const { pointer, calls } = setup("erase");
    pointer("pointerdown", 10, 10, 0);
    pointer("pointerup", 10, 10, 0);
    pointer("pointerdown", 12, 12, 2);
    pointer("pointerup", 12, 12, 2);
    expect(calls).toEqual([true, true]);
  });

  it("in Paint mode a left press paints and a right press erases", () => {
    const { pointer, calls } = setup("paint");
    pointer("pointerdown", 10, 10, 0);
    pointer("pointerup", 10, 10, 0);
    pointer("pointerdown", 12, 12, 2);
    pointer("pointerup", 12, 12, 2);
    expect(calls).toEqual([false, true]);
  });

  it("in Pan mode no press applies cells", () => {
    const { pointer, calls } = setup("pan");
    for (const b of [0, 2]) { pointer("pointerdown", 10, 10, b); pointer("pointerup", 10, 10, b); }
    expect(calls).toEqual([]);
  });
});

// Spec 034 interface: setBlocked (a peek) starts no stroke, and lifting it lets one start again.
describe("setBlocked", () => {
  it("no press applies cells while blocked; after unblocking a press paints", () => {
    const { brush, pointer, calls } = setup("paint");
    brush.setBlocked(true);
    pointer("pointerdown", 10, 10);
    expect(brush.stroking()).toBe(false);
    pointer("pointerup", 10, 10);
    expect(calls).toEqual([]);
    brush.setBlocked(false);
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    expect(calls).toEqual([false]);
  });
});
