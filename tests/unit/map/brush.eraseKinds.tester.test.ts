import { afterEach, describe, expect, it, vi } from "vitest";
import type { Erase } from "../../../src/core/labelStore";
import { createBrush, type BrushMode } from "../../../src/map/brush";
import { BRUSH_GRID, fakeBrushMap } from "../helpers/fakeBrushMap";

vi.mock("maplibre-gl", () => ({ Point: class { constructor(readonly x: number, readonly y: number) {} } }));
vi.mock("../../../src/map/hover", () => ({ ERASE_COLOUR: "#ffffff", showHover: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); });

function setup(mode: BrushMode) {
  const { map } = fakeBrushMap(vi.stubGlobal);
  const calls: Erase[] = [];
  const brush = createBrush(map, { side: () => 1, colour: () => "#ff0000", cells: (_c, _s, e) => { calls.push(e); }, onStroke: () => {}, panning: () => false });
  brush.setImagery(BRUSH_GRID);
  brush.setMode(mode);
  const canvas = map.getCanvasContainer() as unknown as EventTarget;
  /** A pen press, move and lift with the given button (2 is the barrel). */
  const pen = (button: number, x = 10, y = 10) => {
    const ev = (type: string, px: number) => Object.assign(new Event(type), { pointerType: "pen", pointerId: 7, button, buttons: type === "pointerup" ? 0 : 1, clientX: px, clientY: y, shiftKey: false, altKey: false });
    canvas.dispatchEvent(ev("pointerdown", x));
    for (const t of ["pointermove", "pointerup"]) { const e = ev(t, x + 3); Object.defineProperty(e, "target", { value: canvas }); (globalThis.window as unknown as EventTarget).dispatchEvent(e); }
  };
  return { brush, calls, pen };
}

// Spec 058 scope 2 and questions 1-2: the barrel follows the right drag in both modes.
describe("stroke erase kinds by pen button", () => {
  it("Erase mode: a pen tip and a pen barrel drag both give \"any\" for every move", () => {
    const { calls, pen } = setup("erase");
    pen(0); pen(2);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(["any"]));
  });

  it("Paint mode: a pen tip paints (false) and a pen barrel removes the selected class (true)", () => {
    const tip = setup("paint");
    tip.pen(0);
    expect(new Set(tip.calls)).toEqual(new Set([false]));
    vi.unstubAllGlobals();
    const barrel = setup("paint");
    barrel.pen(2);
    expect(new Set(barrel.calls)).toEqual(new Set([true]));
  });

  it("switching Erase to Paint between strokes changes the next stroke's kind", () => {
    const { brush, calls, pen } = setup("erase");
    pen(0);
    const n = calls.length;
    brush.setMode("paint");
    pen(2);
    expect(new Set(calls.slice(0, n))).toEqual(new Set(["any"]));
    expect(new Set(calls.slice(n))).toEqual(new Set([true]));
  });

  it("Fill, Polygon, Smart and Pan never call cells, with either button", () => {
    for (const mode of ["fill", "polygon", "smart", "pan"] as const) {
      const { calls, pen } = setup(mode);
      pen(0); pen(2);
      expect(calls, mode).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("the pen eraser end (button 5) does nothing in Erase mode (out of scope, unchanged)", () => {
    const { calls, pen } = setup("erase");
    pen(5);
    expect(calls).toEqual([]);
  });
});
