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

type Mods = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean };
const code = (key: string) => (key === "`" ? "Backquote" : `Key${key.toUpperCase()}`);

function setup(init: { open?: boolean; canPaint?: boolean; stroking?: boolean; peeks?: boolean } = {}) {
  const state = { open: true, canPaint: true, stroking: false, peeks: true, ...init };
  const modes: BrushMode[] = [];
  const view: string[] = []; // "toggle", "peek true", "peek false"
  const picks: number[] = [];
  initLabelKeys({
    open: () => state.open, brush: { setSpace() {} }, size: { step() {} }, select() {}, classCount: () => 2,
    setMode: (m) => { modes.push(m); }, canPaint: () => state.canPaint, stroking: () => state.stroking,
    view: { toggle: () => { view.push("toggle"); }, peek: (on) => { view.push(`peek ${on}`); return on ? state.peeks : true; } },
    pick: () => { picks.push(1); },
  });
  const send = (type: string, key: string, mods: Mods = {}) =>
    window.dispatchEvent(Object.assign(new Event(type), { key, code: code(key), ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...mods }));
  const press = (key: string, mods: Mods = {}) => send("keydown", key, mods);
  const release = (key: string, mods: Mods = {}) => send("keyup", key, mods);
  return { modes, view, press, release, state, picks };
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

  it("f selects Fill, and not while Paint is disabled (spec 054 criterion 7)", () => {
    const { modes, press, state } = setup();
    press("f");
    state.canPaint = false;
    press("f");
    expect(modes).toEqual(["fill"]);
  });

  it("B and E do nothing while Paint is disabled; P and Escape still select Pan", () => {
    const { modes, press } = setup({ canPaint: false });
    for (const k of ["b", "e", "B", "E", "p", "Escape"]) press(k);
    expect(modes).toEqual(["pan", "pan"]);
  });
});

// Spec 034 criteria 1 and 2.
describe("label visibility keys", () => {
  it("h toggles once per press; a repeated keydown does nothing", () => {
    const { view, press, release } = setup();
    press("h"); release("h");
    press("h"); press("h", { repeat: true }); release("h");
    expect(view).toEqual(["toggle", "toggle"]);
  });

  it("the peek key peeks on keydown and stops on keyup; repeats do nothing; a window blur stops it", () => {
    const { view, press, release } = setup();
    press("`"); press("`", { repeat: true }); press("`", { repeat: true });
    release("`");
    expect(view).toEqual(["peek true", "peek false"]);
    press("`");
    window.dispatchEvent(new Event("blur"));
    expect(view).toEqual(["peek true", "peek false", "peek true", "peek false"]);
  });

  it("neither key acts in a text field, with Ctrl held or before open; peek doesn't start during a stroke", () => {
    const { view, press, release, state } = setup();
    doc.activeElement = new Input("text");
    press("h"); press("`"); release("`");
    doc.activeElement = null;
    press("h", { ctrlKey: true }); press("`", { ctrlKey: true }); release("`", { ctrlKey: true });
    state.open = false;
    press("h"); press("`"); release("`");
    state.open = true;
    state.stroking = true;
    press("`"); release("`");
    expect(view).toEqual([]);
  });
});

// Spec 035 criterion 8: only a peek that started ends.
describe("peek start", () => {
  it("when peek(true) starts none, neither the keyup nor a blur calls peek(false)", () => {
    const { view, press, release } = setup({ peeks: false });
    press("`"); release("`");
    press("`"); window.dispatchEvent(new Event("blur"));
    expect(view).toEqual(["peek true", "peek true"]);
  });

  it("when peek(true) starts one, the keyup calls peek(false) once", () => {
    const { view, press, release } = setup();
    press("`"); release("`"); release("`");
    window.dispatchEvent(new Event("blur"));
    expect(view).toEqual(["peek true", "peek false"]);
  });
});

// Spec 038 scope 2.
describe("pick key", () => {
  it("i and I pick; not in a text field, with Ctrl, Meta or Alt held, or before open", () => {
    const { picks, modes, press, state } = setup();
    press("i"); press("I");
    expect(picks).toHaveLength(2);
    doc.activeElement = new Input("text");
    press("i");
    doc.activeElement = null;
    for (const mod of ["ctrlKey", "metaKey", "altKey"]) press("i", { [mod]: true });
    state.open = false;
    press("i");
    expect(picks).toHaveLength(2);
    expect(modes).toEqual([]);
  });
});
