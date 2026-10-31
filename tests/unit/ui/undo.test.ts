import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyStore } from "../../../src/core/labelStore";
import { initUndo } from "../../../src/ui/undo";

// Spec 037 criterion 5 and scope 5's button. Node has no DOM: the window, buttons and keydowns as plain objects.
type Key = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };
class Button extends EventTarget { disabled = false; click() { if (!this.disabled) this.dispatchEvent(new Event("click")); } }

function setup(platform = "Win32") {
  const keys: ((e: Key & { preventDefault(): void }) => void)[] = [];
  vi.stubGlobal("window", { addEventListener: (_t: string, f: (typeof keys)[number]) => keys.push(f) });
  vi.stubGlobal("navigator", { platform });
  const store = emptyStore(256, 256);
  let blocked = false, shortcut = true;
  const button = new Button(), redoButton = new Button();
  const undone = vi.fn();
  const u = initUndo({ button: button as unknown as HTMLButtonElement, redoButton: redoButton as unknown as HTMLButtonElement,
    store: () => store, blocked: () => blocked, shortcut: () => shortcut, undone });
  // one stroke that labels tile 0,0, then undone
  const s = u.history.begin();
  u.history.record(s, ["0,0"]);
  store.tiles.set("0,0", new Uint8Array(256 * 256).fill(1));
  u.history.end(s);
  u.sync();
  button.click();
  const press = (k: Key) => { const e = { ...k, preventDefault: vi.fn() }; keys.forEach((f) => f(e)); return e; };
  return { u, store, button, redoButton, undone, press, block: (b: boolean) => { blocked = b; u.sync(); }, typing: (t: boolean) => { shortcut = !t; } };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("redo keys and button", () => {
  for (const [name, k, platform] of [
    ["Ctrl+Shift+Z", { key: "Z", ctrlKey: true, shiftKey: true }, "Win32"],
    ["Meta+Shift+Z (macOS)", { key: "Z", metaKey: true, shiftKey: true }, "MacIntel"],
    ["Ctrl+Y", { key: "y", ctrlKey: true }, "Win32"],
  ] as const) {
    it(`${name} redoes the undone stroke and redraws its tiles`, () => {
      const t = setup(platform);
      expect(t.store.tiles.size).toBe(0);
      expect(t.redoButton.disabled).toBe(false);
      t.undone.mockClear();
      const e = t.press(k);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(t.store.tiles.has("0,0")).toBe(true);
      expect(t.undone).toHaveBeenCalledWith(["0,0"]);
      expect(t.redoButton.disabled).toBe(true);
      expect(t.button.disabled).toBe(false);
    });

    it(`${name} does nothing in a text field or while blocked`, () => {
      const t = setup(platform);
      t.typing(true);
      t.press(k);
      expect(t.store.tiles.size).toBe(0);
      t.typing(false);
      t.block(true);
      expect(t.redoButton.disabled).toBe(true);
      t.press(k);
      t.redoButton.dispatchEvent(new Event("click"));
      expect(t.store.tiles.size).toBe(0);
      t.block(false);
      t.press(k);
      expect(t.store.tiles.size).toBe(1);
    });
  }

  it("Ctrl+Z is still undo, not redo; the Redo button redoes", () => {
    const t = setup();
    t.press({ key: "z", ctrlKey: true });
    expect(t.store.tiles.size).toBe(0);
    t.redoButton.click();
    expect(t.store.tiles.size).toBe(1);
    t.press({ key: "z", ctrlKey: true });
    expect(t.store.tiles.size).toBe(0);
  });

  it("clear() empties the redo stack and disables Redo", () => {
    const t = setup();
    t.u.clear();
    expect(t.redoButton.disabled).toBe(true);
    t.press({ key: "y", ctrlKey: true });
    expect(t.store.tiles.size).toBe(0);
  });
});
