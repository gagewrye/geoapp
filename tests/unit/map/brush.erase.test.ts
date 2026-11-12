import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrush, type BrushMode } from "../../../src/map/brush";
import { brushCursor, eraserCursor } from "../../../src/map/cursor";
import { BRUSH_GRID, fakeBrushMap } from "../helpers/fakeBrushMap";

vi.mock("maplibre-gl", () => ({ Point: class { constructor(readonly x: number, readonly y: number) {} } }));
const hovers: { colour: string; dashed: boolean }[] = [];
vi.mock("../../../src/map/hover", () => ({
  ERASE_COLOUR: "#ffffff",
  showHover: (_m: unknown, _r: unknown, colour: string, dashed = false) => { hovers.push({ colour, dashed }); },
}));
afterEach(() => { vi.unstubAllGlobals(); hovers.length = 0; });

function setup(mode: BrushMode) {
  const { map } = fakeBrushMap(vi.stubGlobal);
  const vars = new Map<string, string>();
  (map.getCanvasContainer() as unknown as { style: unknown }).style = { setProperty: (k: string, v: string) => vars.set(k, v) };
  let colour = "#ff0000";
  const brush = createBrush(map, { side: () => 1, colour: () => colour, cells: () => {}, onStroke: () => {}, panning: () => false });
  brush.setImagery(BRUSH_GRID);
  brush.setMode(mode);
  return { brush, vars, setColour: (c: string) => { colour = c; brush.refresh(); } };
}

// Spec 058 scope 3 and questions 3 and 6 (the unit side of criteria 7 and 8).
describe("Erase mode's cursor and footprint", () => {
  it("Erase mode shows the eraser cursor, whatever the class colour", () => {
    const { vars, setColour } = setup("erase");
    expect(vars.get("--brush-cursor")).toBe(eraserCursor());
    setColour("#00ff00");
    expect(vars.get("--brush-cursor")).toBe(eraserCursor());
  });

  it("Paint mode keeps the brush cursor in the class colour", () => {
    const { brush, vars } = setup("erase");
    brush.setMode("paint");
    expect(vars.get("--brush-cursor")).toBe(brushCursor("#ff0000"));
  });

  it("the footprint is dashed white in Erase and solid in the class colour in Paint", () => {
    const { brush } = setup("erase");
    expect(hovers.at(-1)).toEqual({ colour: "#ffffff", dashed: true });
    brush.setMode("paint");
    expect(hovers.at(-1)).toEqual({ colour: "#ff0000", dashed: false });
  });
});
