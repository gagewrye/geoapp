import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrushMode } from "../../../src/map/brush";
import { initLabelKeys } from "../../../src/ui/labelKeys";

// Spec 033 criterion 2. Node has no DOM: just enough element classes for inTextField's instanceof checks.
class El { matches() { return false; } }
class HtmlEl extends El { isContentEditable = false; }
class Input extends HtmlEl { constructor(readonly type = "text") { super(); } }
class TextArea extends HtmlEl {}
class Select extends HtmlEl {}
class Button extends HtmlEl {}

let doc: { activeElement: El | null };
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  doc = { activeElement: null };
  vi.stubGlobal("document", doc);
  for (const [n, c] of Object.entries({ Element: El, HTMLElement: HtmlEl, HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: Select, HTMLButtonElement: Button })) vi.stubGlobal(n, c);
});
afterEach(() => { vi.unstubAllGlobals(); });

function setup(state = { open: true, canPaint: true }) {
  const modes: BrushMode[] = [];
  initLabelKeys({
    open: () => state.open, brush: { setSpace() {} }, size: { step() {} }, select() {}, classCount: () => 2,
    setMode: (m) => { modes.push(m); }, canPaint: () => state.canPaint,
  });
  const press = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) =>
    window.dispatchEvent(Object.assign(new Event("keydown"), { key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, ...mods }));
  return { modes, press, state };
}

describe("mode keys", () => {
  it("b, e, p and Escape select Paint, Erase, Pan and Pan", () => {
    const { modes, press } = setup();
    for (const k of ["b", "e", "p", "Escape"]) press(k);
    expect(modes).toEqual(["paint", "erase", "pan", "pan"]);
  });

  it("do nothing in a class-name field, with Ctrl, Meta or Alt held, or before open", () => {
    const { modes, press, state } = setup();
    doc.activeElement = new Input("text");
    for (const k of ["b", "e", "p", "Escape"]) press(k);
    doc.activeElement = null;
    for (const mod of ["ctrlKey", "metaKey", "altKey"]) for (const k of ["b", "e", "p", "Escape"]) press(k, { [mod]: true });
    state.open = false;
    for (const k of ["b", "e", "p", "Escape"]) press(k);
    expect(modes).toEqual([]);
  });

  it("B and E do nothing while Paint is disabled; P and Escape still select Pan", () => {
    const { modes, press } = setup({ open: true, canPaint: false });
    for (const k of ["b", "e", "B", "E", "p", "Escape"]) press(k);
    expect(modes).toEqual(["pan", "pan"]);
  });
});
