import { afterEach, describe, expect, it, vi } from "vitest";
import { handleNear, handlePoints, type Rect } from "../../../src/core/boxes";
import { createBrush } from "../../../src/map/brush";
import { createBoxTool } from "../../../src/map/boxTool";
import { BRUSH_GRID, FakeEl, fakeBrushMap } from "../helpers/fakeBrushMap";

vi.mock("maplibre-gl", () => ({ Point: class { constructor(readonly x: number, readonly y: number) {} } }));
vi.mock("../../../src/map/hover", () => ({ ERASE_COLOUR: "#ffffff", showHover: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); });

// Spec 064 criterion 2: the brush and the box tool on one fake map, where screen (x, y) is raster pixel (x, y) of a 50 x 50 raster.
function setup() {
  const { map, pointer } = fakeBrushMap(vi.stubGlobal);
  const off = new Set<string>();
  const handler = (name: string) => ({ enable: () => { off.delete(name); }, disable: () => { off.add(name); } });
  Object.assign(map, {
    dragRotate: handler("rotate"), doubleClickZoom: handler("dblclick"), boxZoom: handler("box"),
    unproject: (p: [number, number] | { x: number; y: number }) => (Array.isArray(p) ? { lng: p[0], lat: -p[1] } : { lng: p.x, lat: -p.y }),
  });
  const log: unknown[] = [], picks: [number, number][] = [];
  let selected: Rect | null = null;
  const brush = createBrush(map, { side: () => 1, colour: () => "#f00", cells: () => { log.push("painted"); }, onStroke: () => {}, panning: () => false, pick: (c) => picks.push(c) });
  createBoxTool(map, {
    active: brush.boxing, grid: () => BRUSH_GRID, selected: () => selected,
    handleAt: (r, x, y) => handleNear(handlePoints(r), x, y), // screen px are raster px here
    start: (g) => log.push(g), drag: () => {}, end: (c) => log.push(["end", c]), cancel: () => log.push("cancel"), click: (c) => log.push(["click", c]),
  });
  brush.setImagery(BRUSH_GRID);
  brush.setMode("box");
  const drag = (a: [number, number], b: [number, number], button = 0, mods = {}) => {
    pointer("pointerdown", a[0], a[1], button, mods);
    pointer("pointermove", b[0], b[1], button, mods);
    pointer("pointerup", b[0], b[1], button, mods);
  };
  const touch = () => {
    const e = Object.assign(new Event("pointerdown"), { pointerType: "touch", pointerId: 2, button: 0, clientX: 10, clientY: 10, altKey: false });
    (map.getCanvasContainer() as unknown as FakeEl).dispatchEvent(e);
  };
  /** Whether a mousedown on the canvas reaches MapLibre. */
  const mousedownStopped = () => {
    const e = Object.assign(new Event("mousedown"), { button: 0, clientX: 10, clientY: 10, altKey: false, shiftKey: false });
    Object.defineProperty(e, "target", { value: map.getCanvasContainer() });
    let stopped = false;
    e.stopPropagation = () => { stopped = true; };
    (map.getContainer() as unknown as EventTarget).dispatchEvent(e);
    return stopped;
  };
  return { brush, drag, touch, log, picks, off, select: (r: Rect | null) => { selected = r; }, mousedownStopped };
}

describe("the box tool's gestures", () => {
  it("a drag on empty imagery draws from the press pixel, and a position off the raster clamps to its edge", () => {
    const t = setup();
    t.drag([10.5, 10.5], [30.5, 20.5]);
    t.drag([40.5, 5.5], [80, -5]);
    expect(t.log).toEqual([{ kind: "draw", from: [10, 10] }, ["end", [30, 20]], { kind: "draw", from: [40, 5] }, ["end", [49, 0]]]);
  });

  it("on the selected box a drag moves it, and near a handle it resizes, a corner within 6 px winning over a nearer edge", () => {
    const t = setup();
    t.select({ x0: 10, y0: 10, x1: 40, y1: 40 });
    t.drag([25, 25], [30, 30]);
    t.drag([41, 25], [48, 25]); // the e handle, just outside the box
    t.drag([38, 13], [45, 5]); // inside, but 3.6 px from ne
    t.select({ x0: 10, y0: 10, x1: 20, y1: 20 });
    t.drag([16.5, 9], [16.5, 2]); // 1.8 px from n, 3.8 px from ne
    t.drag([30, 30], [35, 35]); // outside: a new box
    expect(t.log.filter((x) => !Array.isArray(x))).toEqual([
      { kind: "move", from: [25, 25] }, { kind: "resize", handle: "e", from: [41, 25] }, { kind: "resize", handle: "ne", from: [38, 13] },
      { kind: "resize", handle: "ne", from: [16, 9] }, { kind: "draw", from: [30, 30] },
    ]);
  });

  it("a move within 4 px is a click, past 4 px a drag", () => {
    const t = setup();
    t.drag([10, 10], [13, 12]);
    t.drag([10, 10], [14.5, 10]);
    expect(t.log).toEqual([["click", [10, 10]], { kind: "draw", from: [10, 10] }, ["end", [14, 10]]]);
  });

  it("with Space held, a middle press or touch nothing is drawn, and an Alt press picks", () => {
    const t = setup();
    t.brush.setSpace(true);
    t.drag([10, 10], [30, 30]);
    t.brush.setSpace(false);
    t.drag([10, 10], [30, 30], 1);
    t.touch();
    t.drag([10, 10], [30, 30], 0, { altKey: true });
    expect(t.log).toEqual([]);
    expect(t.picks).toEqual([[10, 10]]);
  });

  it("in Box mode the three handlers are off and MapLibre sees no mousedown; leaving it, or Space, gives them back", () => {
    const t = setup();
    expect([...t.off].sort()).toEqual(["box", "dblclick", "rotate"]);
    expect(t.mousedownStopped()).toBe(true);
    t.brush.setSpace(true);
    expect([...t.off]).toEqual([]);
    expect(t.mousedownStopped()).toBe(false);
    t.brush.setSpace(false);
    t.brush.setMode("pan");
    expect([...t.off]).toEqual([]);
    expect(t.mousedownStopped()).toBe(false);
  });
});
