import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrushMode } from "../../../src/map/brush";
import { FakeDocument, type FakeElement } from "../helpers/fakeDom";

// Spec 062 criteria 2-3, tester: setMode in ui/modes.ts really follows the kind, using a two-kind KINDS mocked in.
vi.mock("../../../src/ui/kinds", async (orig) => {
  const real = await orig<typeof import("../../../src/ui/kinds")>();
  return {
    ...real,
    KINDS: [
      { id: "mask", name: "Masks", modes: ["paint", "erase", "polygon"], groups: ["tools-mask", "brush-group"], sections: ["mask-view"] },
      { id: "b", name: "B", modes: ["fill"], groups: ["tools-b"], sections: ["view-b"] },
    ],
  };
});
const { initModes } = await import("../../../src/ui/modes");
const { initKinds } = await import("../../../src/ui/kinds");

type El = FakeElement & { hidden?: boolean };
const IDS = ["mode-pan", "mode-paint", "mode-erase", "mode-fill", "mode-polygon", "mode-smart", "smart-apply", "kinds", "tools-mask", "brush-group", "mask-view", "tools-b", "view-b"];

function harness() {
  const doc = new FakeDocument();
  const els = new Map<string, El>(IDS.map((i) => [i, doc.createElement(i.startsWith("mode") ? "button" : "div")]));
  const box = els.get("kinds")!;
  vi.stubGlobal("document", {
    getElementById: (i: string) => els.get(i) ?? box.querySelectorAll("button").find((b) => b.getAttribute("id") === i) ?? null,
    createElement: (t: string) => doc.createElement(t),
  });
  const calls: string[] = [];
  const brush = { setMode: vi.fn((m: BrushMode) => calls.push(`brush:${m}`)), stroking: () => false, setBlocked: vi.fn() };
  const view = { show: vi.fn(), peek: vi.fn(() => false), peeking: () => false };
  const toolChanged = vi.fn(() => calls.push(`tool:${modes.mode()}`));
  const modes = initModes({ brush, view, toolChanged, smart: vi.fn() });
  const hidden = (i: string) => els.get(i)!.hidden === true;
  const radio = (i: string) => box.querySelectorAll("button").find((b) => b.getAttribute("id") === `kind-${i}`)!;
  return { modes, els, box, hidden, radio, brush, calls };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("ui/modes setMode follows the label kind (criterion 2, via modes.ts)", () => {
  it("starts in the first kind with the other kind hidden, and #kinds shown with two kinds", () => {
    const h = harness();
    expect(h.box.hidden).toBe(false);
    expect(["tools-mask", "brush-group", "mask-view"].map(h.hidden)).toEqual([false, false, false]);
    expect(["tools-b", "view-b"].map(h.hidden)).toEqual([true, true]);
    expect(h.calls).toEqual([]); // no setMode at start-up
  });

  it("clicking another kind's mode button switches kind first, with no extra Pan step", () => {
    const h = harness();
    h.els.get("mode-paint")!.click();
    h.calls.length = 0;
    h.els.get("mode-fill")!.click();
    expect(h.modes.mode()).toBe("fill");
    expect(["tools-b", "view-b"].map(h.hidden)).toEqual([false, false]);
    expect(["tools-mask", "brush-group", "mask-view"].map(h.hidden)).toEqual([true, true, true]);
    expect(h.calls).toEqual(["brush:fill", "tool:fill"]);
    expect(h.els.get("mode-fill")!.getAttribute("aria-pressed")).toBe("true");
    expect(h.radio("b").getAttribute("aria-checked")).toBe("true");
  });

  it("setMode called directly (key path) also follows the kind", () => {
    const h = harness();
    h.modes.setMode("fill");
    expect(h.hidden("tools-b")).toBe(false);
    h.modes.setMode("erase");
    expect(h.hidden("tools-b")).toBe(true);
    expect(h.hidden("tools-mask")).toBe(false);
    expect(h.modes.mode()).toBe("erase");
  });

  it("clicking another kind's radio while in a mode of the old kind selects Pan through setMode", () => {
    const h = harness();
    h.modes.setMode("paint");
    h.calls.length = 0;
    h.radio("b").click();
    expect(h.modes.mode()).toBe("pan");
    expect(h.calls).toEqual(["brush:pan", "tool:pan"]);
    expect(h.els.get("mode-pan")!.getAttribute("aria-pressed")).toBe("true");
    expect(h.els.get("mode-paint")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("Pan and Smart are kept across kind switches, and the shared buttons are never hidden", () => {
    for (const m of ["pan", "smart"] as const) {
      const h = harness();
      h.modes.setMode(m);
      h.calls.length = 0;
      h.radio("b").click();
      h.radio("mask").click();
      expect(h.modes.mode()).toBe(m);
      expect(h.calls).toEqual([]);
      expect(["mode-pan", "mode-smart"].map(h.hidden)).toEqual([false, false]);
      vi.unstubAllGlobals();
    }
  });

  it("re-selecting the current kind keeps its own mode", () => {
    const h = harness();
    h.modes.setMode("polygon");
    h.radio("mask").click();
    expect(h.modes.mode()).toBe("polygon");
  });
});

describe("initKinds edge cases", () => {
  it("a kind with a group id missing from the DOM fails loudly rather than silently showing it", () => {
    const doc = new FakeDocument();
    const box = doc.createElement("div");
    vi.stubGlobal("document", { getElementById: (i: string) => (i === "kinds" ? box : null), createElement: (t: string) => doc.createElement(t) });
    const kinds = [{ id: "mask", name: "M", modes: ["paint"], groups: ["nope"], sections: [] }] as never;
    expect(() => initKinds({ kinds, mode: () => "pan", setMode: vi.fn() })).toThrow();
  });
});
