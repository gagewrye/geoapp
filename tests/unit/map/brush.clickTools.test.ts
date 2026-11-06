import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrush, type BrushMode } from "../../../src/map/brush";
import { BRUSH_GRID, FakeEl, fakeBrushMap } from "../helpers/fakeBrushMap";

vi.mock("maplibre-gl", () => ({ Point: class { constructor(readonly x: number, readonly y: number) {} } }));
vi.mock("../../../src/map/hover", () => ({ showHover: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); });

// Spec 054 criterion 7: Fill and Polygon take clicks as Smart does, and only they turn double-click zoom off.
function setup(mode: BrushMode) {
  const { map, pointer } = fakeBrushMap(vi.stubGlobal);
  const off = new Set<string>();
  const handler = (name: string) => ({ enable: () => { off.delete(name); }, disable: () => { off.add(name); } });
  Object.assign(map, { dragRotate: handler("rotate"), doubleClickZoom: handler("dblclick"), boxZoom: handler("box") });
  const clicks: [number, number][] = [], cells: boolean[] = [], classes = new Map<string, boolean>();
  let rights = 0;
  (map.getCanvasContainer() as unknown as FakeEl).classList = { toggle: (c: string, on: boolean) => { classes.set(c, on); } } as never;
  const brush = createBrush(map, {
    side: () => 1, colour: () => "#ff0000", cells: (_c, _s, erase) => { cells.push(erase); }, onStroke: () => {}, panning: () => false,
    click: (cell) => clicks.push(cell), discard: () => { rights++; },
  });
  brush.setImagery(BRUSH_GRID);
  brush.setMode(mode);
  const click = (x: number, y: number, button = 0, dx = 0) => { pointer("pointerdown", x, y, button); pointer("pointerup", x + dx, y, button); };
  const shiftStopped = () => {
    const e = Object.assign(new Event("mousedown"), { button: 0, clientX: 10, clientY: 10, altKey: false, shiftKey: true });
    Object.defineProperty(e, "target", { value: map.getCanvasContainer() });
    let stopped = false;
    e.stopPropagation = () => { stopped = true; };
    (map.getContainer() as unknown as EventTarget).dispatchEvent(e);
    return stopped;
  };
  return { brush, click, clicks, cells, rights: () => rights, off, classes, shiftStopped };
}

describe("Fill and Polygon modes on the brush", () => {
  for (const mode of ["fill", "polygon"] as BrushMode[]) {
    it(`${mode}: a left click on the raster calls click with its cell, a drag doesn't, and nothing paints`, () => {
      const t = setup(mode);
      t.click(10, 20);
      t.click(30, 20, 0, 10); // a pan
      t.click(80, 20); // off the 50 px raster
      expect(t.clicks).toEqual([[10, 20]]);
      expect(t.cells).toEqual([]);
    });

    it(`${mode}: a right click calls discard, and a Shift+left press is kept from MapLibre's box zoom`, () => {
      const t = setup(mode);
      t.click(10, 20, 2);
      expect(t.rights()).toBe(1);
      expect(t.clicks).toEqual([]);
      expect(t.shiftStopped()).toBe(true);
    });

    it(`${mode}: double-click zoom is off, rotate and box zoom stay on, and the crosshair shows; Space and Pan give them back`, () => {
      const t = setup(mode);
      expect([...t.off]).toEqual(["dblclick"]);
      expect(t.classes.get("click-cursor")).toBe(true);
      t.brush.setSpace(true);
      expect([...t.off]).toEqual([]);
      expect(t.classes.get("click-cursor")).toBe(false);
      t.brush.setSpace(false);
      expect([...t.off]).toEqual(["dblclick"]);
      t.brush.setMode("pan");
      expect([...t.off]).toEqual([]);
    });
  }

  it("Paint still turns all three off, Smart none, and moving between them leaves only what the new mode turns off", () => {
    const t = setup("paint");
    expect([...t.off].sort()).toEqual(["box", "dblclick", "rotate"]);
    t.brush.setMode("polygon");
    expect([...t.off]).toEqual(["dblclick"]);
    t.brush.setMode("smart");
    expect([...t.off]).toEqual([]);
    expect(t.classes.get("click-cursor")).toBe(false);
    t.brush.setMode("fill");
    t.brush.setMode("erase");
    expect([...t.off].sort()).toEqual(["box", "dblclick", "rotate"]);
  });

  it("a peek hides the labels, so Fill and Polygon take no click under it; Smart's clicks are as before", () => {
    for (const mode of ["fill", "polygon"] as BrushMode[]) {
      const t = setup(mode);
      t.brush.setBlocked(true);
      t.click(10, 20);
      t.click(10, 20, 2);
      expect([t.clicks.length, t.rights()]).toEqual([0, 0]);
      t.brush.setBlocked(false);
      t.click(10, 20);
      expect(t.clicks).toEqual([[10, 20]]);
    }
    const s = setup("smart");
    s.brush.setBlocked(true);
    s.click(10, 20);
    expect(s.clicks).toEqual([[10, 20]]);
  });

  it("with no imagery open the click modes do nothing", () => {
    const t = setup("fill");
    t.brush.setImagery(null);
    t.click(10, 20);
    expect(t.clicks).toEqual([]);
    expect([...t.off]).toEqual([]);
  });
});
