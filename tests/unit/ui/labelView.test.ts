import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { applyLabelView } from "../../../src/map/layers";
import { initLabelView } from "../../../src/ui/labelView";

vi.mock("../../../src/map/layers", () => ({ DEFAULT_LABEL_OPACITY: 0.6, applyLabelView: vi.fn() }));

// Spec 034 criterion 3. Node has no DOM: the slider, its text and the checkbox as plain event targets.
class Field extends EventTarget { value = ""; checked = false; textContent = ""; }
let els: Record<string, Field>;
beforeEach(() => {
  els = { "label-opacity": new Field(), "label-opacity-text": new Field(), "show-labels": new Field() };
  vi.stubGlobal("document", { getElementById: (id: string) => els[id] });
  vi.mocked(applyLabelView).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

const map = {} as MapLibreMap;
const lastView = () => vi.mocked(applyLabelView).mock.calls.at(-1)![1];

describe("labelView peek and toggle", () => {
  it("peek(true) hides the layers without touching the checkbox, opacity or saved view; peek(false) restores them", () => {
    const visible: boolean[] = [], changes: number[] = [];
    const view = initLabelView(map, (v) => visible.push(v), () => changes.push(1));
    view.set(0.35, true);
    visible.length = changes.length = 0;
    view.peek(true);
    expect(view.peeking()).toBe(true);
    expect(lastView()).toEqual({ opacity: 0.35, visible: false });
    expect(els["show-labels"]!.checked).toBe(true);
    view.peek(false);
    expect(view.peeking()).toBe(false);
    expect(lastView()).toEqual({ opacity: 0.35, visible: true });
    expect(els["show-labels"]!.checked).toBe(true);
    expect(view.get()).toEqual({ opacity: 0.35, visible: true });
    expect(visible).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("peeking does nothing while the labels are already hidden", () => {
    const view = initLabelView(map, () => {});
    view.set(0.6, false);
    const calls = vi.mocked(applyLabelView).mock.calls.length;
    view.peek(true);
    expect(view.peeking()).toBe(false);
    view.peek(false);
    expect(vi.mocked(applyLabelView).mock.calls.length).toBe(calls);
  });

  it("toggle() twice returns to the start, reporting one hide (which selects Pan) and one show", () => {
    const visible: boolean[] = [];
    const view = initLabelView(map, (v) => visible.push(v));
    view.toggle();
    expect(els["show-labels"]!.checked).toBe(false);
    expect(lastView()).toEqual({ opacity: 0.6, visible: false });
    view.toggle();
    expect(els["show-labels"]!.checked).toBe(true);
    expect(lastView()).toEqual({ opacity: 0.6, visible: true });
    expect(visible.filter((v) => !v)).toHaveLength(1);
    expect(visible).toEqual([false, true]);
  });
});
