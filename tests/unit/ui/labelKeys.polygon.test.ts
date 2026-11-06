import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrushMode } from "../../../src/map/brush";
import { initLabelKeys } from "../../../src/ui/labelKeys";

// Spec 054 criterion 8. Node has no DOM: just enough element classes for inTextField's instanceof checks.
class El { matches() { return false; } }
class HtmlEl extends El { isContentEditable = false; }
class Input extends HtmlEl { constructor(readonly type = "text") { super(); } }
class Button extends HtmlEl {}

let doc: { activeElement: El | null };
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  doc = { activeElement: null };
  vi.stubGlobal("document", doc);
  for (const [n, c] of Object.entries({ Element: El, HTMLElement: HtmlEl, HTMLInputElement: Input, HTMLTextAreaElement: class extends HtmlEl {}, HTMLSelectElement: class extends HtmlEl {}, HTMLButtonElement: Button })) vi.stubGlobal(n, c);
});
afterEach(() => { vi.unstubAllGlobals(); });

function setup(init: { canPaint?: boolean; corners?: number; smartPrompt?: boolean } = {}) {
  const state = { canPaint: true, corners: 0, smartPrompt: false, ...init };
  const modes: BrushMode[] = [], calls: string[] = [];
  initLabelKeys({
    open: () => true, brush: { setSpace() {} }, size: { step() {} }, select() {}, classCount: () => 2,
    setMode: (m) => { modes.push(m); }, canPaint: () => state.canPaint, stroking: () => false, view: { toggle() {}, peek: () => true },
    smart: { choose() {}, canChoose: () => true, apply: () => { calls.push("smart.apply"); return state.smartPrompt; }, discard: () => { calls.push("smart.discard"); return state.smartPrompt; } },
    polygon: {
      apply: () => { calls.push("apply"); return state.corners >= 3; },
      back: () => { calls.push("back"); return state.corners > 0; },
      discard: () => { calls.push("discard"); return state.corners > 0; },
    },
  });
  const press = (key: string, mods: { ctrlKey?: boolean } = {}) => {
    const e = Object.assign(new Event("keydown", { cancelable: true }), { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...mods });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { modes, calls, press, state };
}

describe("Fill and Polygon keys", () => {
  it("f and l select Fill and Polygon, and do nothing while Paint is disabled, in a text field or with Ctrl held", () => {
    const t = setup();
    for (const k of ["f", "L"]) t.press(k);
    expect(t.modes).toEqual(["fill", "polygon"]);
    t.state.canPaint = false;
    for (const k of ["f", "l"]) t.press(k);
    t.state.canPaint = true;
    doc.activeElement = new Input("text");
    for (const k of ["f", "l"]) t.press(k);
    doc.activeElement = null;
    for (const k of ["f", "l"]) t.press(k, { ctrlKey: true });
    expect(t.modes).toEqual(["fill", "polygon"]);
  });

  it("Enter fills a polygon of 3 corners and is prevented; with fewer it isn't, and a focused button keeps its Enter", () => {
    const t = setup({ corners: 3 });
    expect(t.press("Enter")).toBe(true);
    expect(t.calls).toEqual(["smart.apply", "apply"]);
    t.state.corners = 2;
    expect(t.press("Enter")).toBe(false);
    doc.activeElement = new Button();
    t.calls.length = 0;
    t.press("Enter");
    expect(t.calls).toEqual([]);
  });

  it("a pending smart selection takes Enter and Escape before the polygon", () => {
    const t = setup({ corners: 3, smartPrompt: true });
    t.press("Enter");
    t.press("Escape");
    expect(t.calls).toEqual(["smart.apply", "smart.discard"]);
  });

  it("Backspace removes a corner and is prevented only when there was one; in a text field it types", () => {
    const t = setup({ corners: 1 });
    expect(t.press("Backspace")).toBe(true);
    t.state.corners = 0;
    expect(t.press("Backspace")).toBe(false);
    doc.activeElement = new Input("text");
    t.calls.length = 0;
    t.press("Backspace");
    expect(t.calls).toEqual([]);
  });

  it("Escape discards a polygon and keeps the tool; with none it selects Pan", () => {
    const t = setup({ corners: 2 });
    expect(t.press("Escape")).toBe(true);
    expect(t.modes).toEqual([]);
    t.state.corners = 0;
    t.press("Escape");
    expect(t.modes).toEqual(["pan"]);
  });
});
