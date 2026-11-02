import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrush, type BrushMode } from "../../../src/map/brush";
import { BRUSH_GRID, FakeEl, fakeBrushMap } from "../helpers/fakeBrushMap";

vi.mock("maplibre-gl", () => ({ Point: class { constructor(readonly x: number, readonly y: number) {} } }));
vi.mock("../../../src/map/hover", () => ({ showHover: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); });

// Spec 049 edge cases (tester): scope 4's pen and touch rules, release targets, the 4 px boundary, other modes.
function setup(mode: BrushMode = "smart", imagery = true) {
  const { map } = fakeBrushMap(vi.stubGlobal);
  const clicks: [[number, number], boolean][] = [], cells: boolean[] = [];
  let discards = 0;
  const brush = createBrush(map, {
    side: () => 1, colour: () => "#ff0000", cells: (_c, _s, erase) => { cells.push(erase); }, onStroke: () => {}, panning: () => false,
    click: (cell, include) => clicks.push([cell, include]), discard: () => { discards++; },
  });
  if (imagery) brush.setImagery(BRUSH_GRID);
  brush.setMode(mode);
  const canvas = map.getCanvasContainer() as unknown as FakeEl;
  type Opts = { pointerType?: string; target?: EventTarget; shiftKey?: boolean; altKey?: boolean };
  const ev = (type: string, x: number, y: number, button: number, o: Opts = {}) => {
    const e = Object.assign(new Event(type), { pointerType: o.pointerType ?? "mouse", pointerId: 1, button, buttons: type === "pointerup" ? 0 : 1,
      clientX: x, clientY: y, shiftKey: o.shiftKey ?? false, altKey: o.altKey ?? false });
    if (type === "pointerdown") canvas.dispatchEvent(e);
    else {
      Object.defineProperty(e, "target", { value: o.target ?? canvas });
      (globalThis.window as unknown as EventTarget).dispatchEvent(e);
    }
  };
  const click = (x: number, y: number, button: number, o: Opts = {}, dx = 0, up: Opts = o) => { ev("pointerdown", x, y, button, o); ev("pointerup", x + dx, y, button, up); };
  const mouse = (button: number, shiftKey: boolean) => {
    const e = Object.assign(new Event("mousedown"), { button, clientX: 10, clientY: 10, altKey: false, shiftKey });
    Object.defineProperty(e, "target", { value: canvas });
    let stopped = false;
    e.stopPropagation = () => { stopped = true; };
    (map.getContainer() as unknown as EventTarget).dispatchEvent(e);
    return stopped;
  };
  return { brush, click, clicks, cells, discards: () => discards, mouse };
}

describe("spec 049 right click edge cases", () => {
  it("a pen barrel-button click (button 2) discards, as a right click does", () => {
    const t = setup();
    t.click(10, 10, 2, { pointerType: "pen" });
    expect(t.discards()).toBe(1);
    expect(t.clicks).toEqual([]);
  });

  it("a touch with button 2 never discards", () => {
    const t = setup();
    t.click(10, 10, 2, { pointerType: "touch" });
    expect(t.discards()).toBe(0);
  });

  it("a right release off the map canvas (e.g. over the panel) doesn't discard", () => {
    const t = setup();
    t.click(10, 10, 2, {}, 0, { target: new FakeEl() });
    expect(t.discards()).toBe(0);
  });

  it("exactly 4 px still discards; 5 px doesn't", () => {
    const a = setup();
    a.click(10, 10, 2, {}, 4);
    expect(a.discards()).toBe(1);
    const b = setup();
    b.click(10, 10, 2, {}, 5);
    expect(b.discards()).toBe(0);
  });

  it("a right press released with the left button (mismatched buttons) does nothing", () => {
    const { map } = fakeBrushMap(vi.stubGlobal);
    let discards = 0;
    const brush = createBrush(map, { side: () => 1, colour: () => "#f00", cells: () => {}, onStroke: () => {}, panning: () => false, discard: () => { discards++; } });
    brush.setImagery(BRUSH_GRID);
    brush.setMode("smart");
    const canvas = map.getCanvasContainer() as unknown as EventTarget;
    const base = { pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10, shiftKey: false, altKey: false };
    canvas.dispatchEvent(Object.assign(new Event("pointerdown"), base, { button: 2, buttons: 2 }));
    const up = Object.assign(new Event("pointerup"), base, { button: 0, buttons: 0 });
    Object.defineProperty(up, "target", { value: canvas });
    (globalThis.window as unknown as EventTarget).dispatchEvent(up);
    expect(discards).toBe(0);
  });

  it("with no imagery open a right click in Smart mode discards nothing", () => {
    const t = setup("smart", false);
    t.click(10, 10, 2);
    expect(t.discards()).toBe(0);
  });

  it("in Erase and Pan modes a right click doesn't discard", () => {
    for (const m of ["erase", "pan"] as const) {
      const t = setup(m);
      t.click(10, 10, 2);
      expect(t.discards()).toBe(0);
    }
  });

  it("Shift+right still discards and adds no point", () => {
    const t = setup();
    t.click(10, 10, 2, { shiftKey: true });
    expect(t.discards()).toBe(1);
    expect(t.clicks).toEqual([]);
  });

  it("a Shift+left click off the raster adds no point and doesn't discard", () => {
    const t = setup();
    t.click(80, 80, 0, { shiftKey: true });
    expect(t.clicks).toEqual([]);
    expect(t.discards()).toBe(0);
  });

  it("Shift held only at release still includes (Shift is read at the press)", () => {
    const t = setup();
    t.click(10, 10, 0, {}, 0, { shiftKey: true });
    expect(t.clicks).toEqual([[[10, 10], true]]);
  });

  it("Shift+left mousedown isn't stopped in Pan mode, with Space held, or with no imagery (box zoom stays)", () => {
    expect(setup("pan").mouse(0, true)).toBe(false);
    const s = setup();
    s.brush.setSpace(true);
    expect(s.mouse(0, true)).toBe(false);
    expect(setup("smart", false).mouse(0, true)).toBe(false);
  });

  it("a Shift+right mousedown in Smart mode isn't stopped (right drags still rotate)", () => {
    expect(setup().mouse(2, true)).toBe(false);
  });
});
