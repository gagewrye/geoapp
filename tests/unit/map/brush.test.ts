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

// Spec 038 criterion 2: an Alt+left press picks, in every mode, and starts no stroke.
describe("Alt+left press picks", () => {
  function picking(mode: BrushMode) {
    const { map, pointer } = fakeBrushMap(vi.stubGlobal);
    const picks: [number, number][] = [], strokes: boolean[] = [], cells: boolean[] = [];
    const brush = createBrush(map, {
      side: () => 1, colour: () => "#ff0000", cells: (_c, _s, erase) => { cells.push(erase); }, onStroke: (a) => strokes.push(a),
      panning: () => false, pick: (cell) => picks.push(cell),
    });
    brush.setImagery(BRUSH_GRID);
    brush.setMode(mode);
    const canvas = map.getCanvasContainer() as unknown as EventTarget;
    const altDown = (x: number, y: number) => {
      const e = Object.assign(new Event("pointerdown"), { pointerType: "mouse", pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y, altKey: true });
      canvas.dispatchEvent(e);
    };
    /** The mousedown MapLibre would get, through the map container's capture listener; whether the brush stopped it. */
    const altMouse = (x: number, y: number) => {
      const e = Object.assign(new Event("mousedown"), { button: 0, clientX: x, clientY: y, altKey: true });
      Object.defineProperty(e, "target", { value: canvas });
      let stopped = false;
      e.stopPropagation = () => { stopped = true; };
      (map.getContainer() as unknown as EventTarget).dispatchEvent(e);
      return stopped;
    };
    return { brush, pointer, picks, strokes, cells, altDown, altMouse };
  }

  for (const mode of ["paint", "erase", "pan"] as const) {
    it(`in ${mode} mode it calls pick with the cell, starts no stroke, and MapLibre gets no mousedown`, () => {
      const t = picking(mode);
      t.altDown(10, 12);
      expect(t.picks).toEqual([[10, 12]]);
      expect(t.brush.stroking()).toBe(false);
      expect(t.altMouse(10, 12)).toBe(true);
      t.pointer("pointerup", 10, 12);
      expect(t.strokes).toEqual([]);
      expect(t.cells).toEqual([]);
    });
  }

  it("off the raster an Alt press picks nothing, and in Pan mode MapLibre keeps the mousedown", () => {
    const t = picking("pan");
    t.altDown(80, 80); // the grid is 50 x 50
    expect(t.picks).toEqual([]);
    expect(t.altMouse(80, 80)).toBe(false);
  });

  it("hoverCell is the raster cell under the last pointer position, or null off the raster", () => {
    const t = picking("pan");
    expect(t.brush.hoverCell()).toBeNull();
    t.pointer("pointermove", 7, 9);
    expect(t.brush.hoverCell()).toEqual([7, 9]);
    t.pointer("pointermove", 70, 9);
    expect(t.brush.hoverCell()).toBeNull();
  });

  it("an Alt keyup is prevented while the pointer is over the map, not otherwise", () => {
    const t = picking("paint");
    const altUp = () => {
      const e = Object.assign(new Event("keyup", { cancelable: true }), { key: "Alt", code: "AltLeft" });
      (globalThis.window as unknown as EventTarget).dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(altUp()).toBe(false);
    t.pointer("pointermove", 7, 9);
    expect(altUp()).toBe(true);
  });
});
