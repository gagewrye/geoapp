import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { addBox } from "../../../src/core/boxes";
import { emptyStore } from "../../../src/core/labelStore";
import type { LabelSource } from "../../../src/io/labelFile";
import type { MaskBase } from "../../../src/io/maskBase";
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

// Spec 074 criterion 4 (ADR 0041): the base reads the app's copy once swapped, and only while it is still the base.
describe("useCopy", () => {
  const source = { meta: { width: 100, height: 100, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] } } as unknown as RasterSource;
  const base = (file: unknown) => ({ file, lut: new Uint8Array(256), count: 1, windows: new Set<string>(), preview: {} }) as unknown as MaskBase;

  it("swaps the live base's file in place, and nothing once another base replaced it", () => {
    const labels = setup();
    labels.open(source);
    const user = { name: "user" } as unknown as LabelSource, copy = { name: "copy" } as unknown as LabelSource;
    const a = base(user);
    labels.replace(emptyStore(100, 100), [{ name: "Water", colour: "#0000ff" }], a);
    expect(labels.useCopy(a, copy)).toBe(true);
    expect(labels.base()).toBe(a);
    expect(labels.base()!.file).toBe(copy);
    const b = base(user);
    labels.replace(emptyStore(100, 100), [{ name: "Water", colour: "#0000ff" }], b);
    expect(labels.useCopy(a, copy)).toBe(false);
    expect(b.file).toBe(user);
  });
});

// Spec 063 scope 6: labels hold the BoxStore; open() empties it and replace() keeps it.
describe("labels' box store", () => {
  const source = { meta: { width: 100, height: 100, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] } } as unknown as RasterSource;
  it("open() gives an empty store, replace() keeps it", () => {
    const labels = setup();
    labels.open(source);
    const first = labels.boxes();
    expect(first.boxes.size).toBe(0);
    addBox(first, { x0: 0, y0: 0, x1: 5, y1: 5 }, 1);
    labels.replace(emptyStore(100, 100), [{ name: "Water", colour: "#0000ff" }]);
    expect(labels.boxes()).toBe(first);
    expect(first.boxes.size).toBe(1);
    labels.open(source);
    expect(labels.boxes()).not.toBe(first);
    expect(labels.boxes().boxes.size).toBe(0);
    expect(labels.boxes().next).toBe(1);
  });
});
