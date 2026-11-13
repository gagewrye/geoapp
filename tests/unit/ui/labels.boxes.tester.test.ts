import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { addBox } from "../../../src/core/boxes";
import { emptyStore } from "../../../src/core/labelStore";
import type { RasterSource } from "../../../src/io/source";
import { initLabels } from "../../../src/ui/labels";

// Spec 063 scope 6 (tester): the undo wiring sees labels' current BoxStore, and open() and replace() clear its history.
const { auto, undoDeps, clears } = vi.hoisted(() => {
  const auto = () => new Proxy({} as Record<string | symbol, unknown>, { get: (t, k) => (t[k] ??= () => {}) });
  return { auto, undoDeps: { current: null as null | { boxes?: () => unknown; undone: (c: { tiles: string[]; boxes: number[] }) => void } }, clears: { n: 0 } };
});
vi.mock("../../../src/io/maskBase", () => ({ baseTile: () => {} }));
vi.mock("../../../src/map/brush", () => ({ createBrush: auto }));
vi.mock("../../../src/ui/brushSize", () => ({ initBrushSize: auto }));
vi.mock("../../../src/ui/classPanel", () => ({ initClassPanel: auto }));
vi.mock("../../../src/ui/labelDisplay", () => ({ labelDisplay: auto }));
vi.mock("../../../src/ui/labelKeys", () => ({ initLabelKeys: () => {}, inTextField: () => false }));
vi.mock("../../../src/ui/labelView", () => ({ initLabelView: auto }));
vi.mock("../../../src/ui/modes", () => ({ initModes: auto }));
vi.mock("../../../src/ui/paint", () => ({ initPaint: auto }));
vi.mock("../../../src/ui/picker", () => ({ initPicker: () => ({ pick: () => {}, cancel: () => {} }) }));
vi.mock("../../../src/ui/undo", () => ({
  initUndo: (deps: NonNullable<typeof undoDeps.current>) => {
    undoDeps.current = deps;
    const u = auto() as Record<string, unknown>;
    u.clear = () => { clears.n++; };
    return u;
  },
}));
afterEach(() => { vi.unstubAllGlobals(); clears.n = 0; undoDeps.current = null; });

function setup() {
  vi.stubGlobal("document", { getElementById: () => ({}) });
  const noop = () => {}, no = () => false;
  return initLabels({ map: {} as MapLibreMap, say: noop, onBusy: noop, onChange: noop, panning: no, imageryBusy: no, importing: no });
}
const source = { meta: { width: 100, height: 100, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] } } as unknown as RasterSource;

describe("labels' boxes and undo (tester)", () => {
  it("the undo wiring's boxes getter follows the store open() swaps in", () => {
    const labels = setup();
    const deps = undoDeps.current!;
    expect(deps.boxes).toBeTypeOf("function");
    labels.open(source);
    expect(deps.boxes!()).toBe(labels.boxes());
    const first = labels.boxes();
    labels.open(source);
    expect(deps.boxes!()).toBe(labels.boxes());
    expect(deps.boxes!()).not.toBe(first);
  });

  it("open() and replace() each clear the history; replace() keeps the boxes", () => {
    const labels = setup();
    labels.open(source);
    expect(clears.n).toBe(1);
    addBox(labels.boxes(), { x0: 0, y0: 0, x1: 2, y1: 2 }, 1);
    labels.replace(emptyStore(100, 100), [{ name: "Water", colour: "#0000ff" }]);
    expect(clears.n).toBe(2);
    expect(labels.boxes().boxes.size).toBe(1);
  });

  it("undone with only box ids doesn't throw (box redraw is a no-op until spec 064)", () => {
    setup().open(source);
    expect(() => undoDeps.current!.undone({ tiles: [], boxes: [1] })).not.toThrow();
  });
});
