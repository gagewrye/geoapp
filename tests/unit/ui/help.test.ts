import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initHelp } from "../../../src/ui/help";
import { SHORTCUTS } from "../../../src/ui/shortcuts";

// Spec 045 criterion 4. Node has no DOM: a dialog, a stub document and the window as an EventTarget.
class Dialog { open = false; showModal() { this.open = true; } close() { this.open = false; } }
const el = (): Record<string, unknown> => ({
  append() {}, setAttribute() {}, replaceChildren() {}, addEventListener() {},
  insertRow: () => ({ insertCell: () => ({ append() {} }) }),
});

let dialog: Dialog;
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { activeElement: null, createElement: el, getElementById: () => null });
  for (const n of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"]) vi.stubGlobal(n, class {});
  dialog = new Dialog();
  initHelp({ dialog: dialog as unknown as HTMLDialogElement, button: el() as unknown as HTMLButtonElement, list: el() as unknown as HTMLElement });
});
afterEach(() => { vi.unstubAllGlobals(); });

const press = (repeat: boolean) => {
  const e = Object.assign(new Event("keydown", { cancelable: true }), { key: "?", code: "Slash", repeat, ctrlKey: false, metaKey: false, altKey: false });
  window.dispatchEvent(e);
  return e;
};

describe("holding ?", () => {
  it("a repeated ? keydown neither opens a closed list nor closes an open one, and no other listener sees it", () => {
    const other = vi.fn();
    window.addEventListener("keydown", other);
    const e = press(true);
    expect(dialog.open).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(other).not.toHaveBeenCalled();
    press(false); // the opening ? isn't swallowed: other listeners ignore it
    expect(dialog.open).toBe(true);
    other.mockClear();
    press(true);
    expect(dialog.open).toBe(true);
    expect(other).not.toHaveBeenCalled();
    press(false);
    expect(dialog.open).toBe(false);
  });
});

// Spec 057 criterion 9: the list shows keys and actions, never a hint
describe("the #help list", () => {
  it("contains none of the hints", () => {
    const texts: string[] = [];
    const node = (): Record<string, unknown> => {
      const n: Record<string, unknown> = {
        append() {}, setAttribute() {}, replaceChildren() {}, addEventListener() {},
        insertRow: () => ({ insertCell: () => node() }),
      };
      Object.defineProperty(n, "textContent", { set: (t: string) => texts.push(t), get: () => "" });
      return n;
    };
    vi.stubGlobal("document", { activeElement: null, createElement: () => node(), getElementById: () => null });
    initHelp({ dialog: new Dialog() as unknown as HTMLDialogElement, button: node() as unknown as HTMLButtonElement, list: node() as unknown as HTMLElement });
    const text = texts.join("\n");
    expect(text).toContain("Smart select");
    for (const s of SHORTCUTS) if (s.hint) expect(text, s.id).not.toContain(s.hint);
  });
});
