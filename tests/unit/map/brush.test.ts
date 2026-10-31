import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrush, type BrushMode } from "../../../src/map/brush";
import { deferMode } from "../../../src/ui/deferMode";
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

// Spec 033 criterion 3.
describe("a mode key mid-stroke", () => {
  it("leaves the stroke running, and the mode is Pan once the stroke ends", () => {
    let ended = () => {};
    const { brush, pointer, calls } = setup("paint", (active) => { if (!active) ended(); });
    const keys = deferMode(brush.stroking, (m) => brush.setMode(m));
    ended = keys.strokeEnded;
    pointer("pointerdown", 10, 10);
    keys.request("pan");
    expect(brush.stroking()).toBe(true);
    expect(brush.mode()).toBe("paint");
    pointer("pointermove", 14, 10);
    expect(calls.length).toBe(2); // the stroke still paints
    pointer("pointerup", 14, 10);
    expect(brush.stroking()).toBe(false);
    expect(brush.mode()).toBe("pan");
  });

  it("applies at once between strokes, and clear() drops a pending one", () => {
    const { brush, pointer } = setup("paint");
    const keys = deferMode(brush.stroking, (m) => brush.setMode(m));
    keys.request("erase");
    expect(brush.mode()).toBe("erase");
    pointer("pointerdown", 10, 10);
    keys.request("pan");
    keys.clear();
    pointer("pointerup", 10, 10);
    keys.strokeEnded();
    expect(brush.mode()).toBe("erase");
  });
});
