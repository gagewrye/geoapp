import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrushMode } from "../../../src/map/brush";
import { KEYMAP, initLabelKeys } from "../../../src/ui/labelKeys";
import { initModes } from "../../../src/ui/modes";
import { SHORTCUTS } from "../../../src/ui/shortcuts";
import { FakeDocument, type FakeElement } from "../helpers/fakeDom";

// Spec 064 criterion 5: R and B switch kind through the real KINDS, and the box keys keep their order after Smart and Polygon.
const IDS = ["kinds", "tools-mask", "brush-group", "mask-view", "tools-box", "smart-apply", ...["paint", "erase", "pan", "smart", "fill", "polygon", "box"].map((m) => `mode-${m}`)];
class El {}
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  for (const n of ["Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement"]) vi.stubGlobal(n, El);
});
afterEach(() => { vi.unstubAllGlobals(); });

function setup(over: { back?: boolean; discard?: boolean } = {}) {
  const doc = new FakeDocument();
  const els = new Map<string, FakeElement & { hidden?: boolean }>(IDS.map((i) => [i, doc.createElement("div")]));
  vi.stubGlobal("document", { activeElement: null, getElementById: (i: string) => els.get(i) ?? null, createElement: (t: string) => doc.createElement(t) });
  const log: string[] = [];
  let boxEscape = false, boxSelected = false;
  const modes = initModes({ brush: { setMode() {}, stroking: () => false, setBlocked() {} }, view: { show() {}, peek: () => false, peeking: () => false }, toolChanged() {}, smart() {} });
  modes.ready(true);
  initLabelKeys({
    open: () => true, brush: { setSpace() {} }, size: { step() {} }, select() {}, classCount: () => 2, setMode: modes.request, canPaint: modes.canPaint,
    stroking: () => false, view: { toggle() {}, peek: () => false },
    polygon: { apply: () => false, back: () => { log.push("corner"); return over.back ?? false; }, discard: () => over.discard ?? false },
    box: { escape: () => { log.push("box escape"); return boxEscape; }, remove: () => { log.push("box remove"); return boxSelected; } },
  });
  const press = (key: string) => {
    const e = Object.assign(new Event("keydown", { cancelable: true }), { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: false, metaKey: false, altKey: false, repeat: false });
    window.dispatchEvent(e);
    return e;
  };
  const hidden = (id: string) => els.get(id)!.hidden;
  return { modes, press, log, hidden, set: (esc: boolean, sel: boolean) => { boxEscape = esc; boxSelected = sel; } };
}

describe("Box keys", () => {
  it("R from Masks selects Boxes and Box, hiding the mask tools; B from Boxes selects Masks and Paint", () => {
    const t = setup();
    expect([t.modes.kind(), t.hidden("tools-box")]).toEqual(["mask", true]);
    t.press("r");
    expect([t.modes.kind(), t.modes.mode()]).toEqual(["box", "box"]);
    expect([t.hidden("tools-mask"), t.hidden("brush-group"), t.hidden("mask-view"), t.hidden("tools-box")]).toEqual([true, true, true, false]);
    t.press("b");
    expect([t.modes.kind(), t.modes.mode() as BrushMode]).toEqual(["mask", "paint"]);
  });

  it("Box is disabled exactly when Paint is", () => {
    const t = setup();
    t.modes.ready(false);
    t.press("r");
    expect(t.modes.mode()).toBe("pan");
  });

  it("R and Delete are in KEYMAP and SHORTCUTS (spec 039 criterion 1)", () => {
    expect([KEYMAP.r, KEYMAP.Delete]).toEqual(["box", "box-delete"]);
    expect(SHORTCUTS.find((s) => s.keys.includes("Delete"))!.id).toBe("box-delete");
  });

  it("Backspace deletes a box only when no polygon corner was removed; Delete deletes it", () => {
    const corner = setup({ back: true });
    corner.press("Backspace");
    expect(corner.log).toEqual(["corner"]);
    const t = setup();
    t.set(false, true);
    expect(t.press("Backspace").defaultPrevented).toBe(true);
    t.press("Delete");
    expect(t.log).toEqual(["corner", "box remove", "box remove"]);
  });

  it("Escape goes to the box after Smart and Polygon, and selects Pan only when the box had nothing to act on", () => {
    const polygon = setup({ discard: true });
    polygon.press("Escape");
    expect(polygon.log).toEqual([]);
    const t = setup();
    t.press("r");
    t.set(true, true);
    t.press("Escape");
    expect(t.modes.mode()).toBe("box");
    t.set(false, false);
    t.press("Escape");
    expect(t.modes.mode()).toBe("pan");
    expect(t.log).toEqual(["box escape", "box escape"]);
  });
});
