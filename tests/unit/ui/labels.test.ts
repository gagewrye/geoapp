import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { emptyStore } from "../../../src/core/labelStore";
import type { RasterSource } from "../../../src/io/source";
import { initLabels } from "../../../src/ui/labels";

// Spec 039 criterion 8. A minimal harness: every module initLabels wires is a stub whose methods are spies.
const { auto, cancel } = vi.hoisted(() => {
  const auto = () => new Proxy({} as Record<string | symbol, unknown>, { get: (t, k) => (t[k] ??= () => {}) });
  return { auto, cancel: { calls: 0 } };
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
vi.mock("../../../src/ui/undo", () => ({ initUndo: auto }));
vi.mock("../../../src/ui/picker", () => ({ initPicker: () => ({ pick: () => {}, cancel: () => { cancel.calls++; } }) }));
afterEach(() => { vi.unstubAllGlobals(); cancel.calls = 0; });

function setup() {
  vi.stubGlobal("document", { getElementById: () => ({}) });
  const noop = () => {}, no = () => false;
  return initLabels({ map: {} as MapLibreMap, say: noop, onBusy: noop, onChange: noop, panning: no, imageryBusy: no, importing: no });
}

describe("labels cancel a pick still reading (spec 039 scope 6)", () => {
  it("open() calls the picker's cancel once", () => {
    const labels = setup();
    const source = { meta: { width: 100, height: 100, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] } } as unknown as RasterSource;
    labels.open(source);
    expect(cancel.calls).toBe(1);
  });

  it("replace() calls the picker's cancel once", () => {
    const labels = setup();
    labels.replace(emptyStore(100, 100), [{ name: "Water", colour: "#0000ff" }]);
    expect(cancel.calls).toBe(1);
  });
});
