import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initHelp } from "../../../src/ui/help";

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
