import { describe, expect, it } from "vitest";
import { labelButtons } from "../../../src/ui/help";
import { KEYMAP } from "../../../src/ui/labelKeys";
import { SHORTCUTS, ariaKey, isSingleKey, keyLabel } from "../../../src/ui/shortcuts";
import { FakeDocument, type FakeElement } from "../helpers/fakeDom";

// Spec 039 criteria 1 and 2.
describe("SHORTCUTS and KEYMAP", () => {
  it("every KEYMAP key is in the SHORTCUTS entry of the same id, and every single SHORTCUTS key is in KEYMAP", () => {
    for (const [key, id] of Object.entries(KEYMAP)) {
      const entry = SHORTCUTS.find((s) => s.keys.includes(key));
      expect(entry, key).toBeDefined();
      expect(entry!.id, key).toBe(id);
    }
    const single = SHORTCUTS.flatMap((s) => s.keys.filter(isSingleKey));
    for (const k of single) expect(KEYMAP[k], k).toBeDefined();
  });

  it("lists scope 1's keys in the six sections", () => {
    const keys = SHORTCUTS.flatMap((s) => s.keys);
    for (const k of ["1", "9", "[", "]", "Space", "KeyW", "KeyA", "KeyS", "KeyD", "Mod+Z", "Mod+Shift+Z", "Ctrl+Y", "b", "e", "p", "Escape", "h",
      "Backquote", "Backslash", "Home", "i", "Alt+click", "Right drag", "Middle drag", "Mouse wheel", "?"]) expect(keys, k).toContain(k);
    // spec 046 scope 8
    const entry = (action: string) => SHORTCUTS.find((s) => s.action === action)?.keys;
    expect(entry("Smart select")).toEqual(["m"]);
    expect(entry("Apply smart selection")).toEqual(["Enter"]);
    // as amended by spec 049 scope 5
    expect(entry("Include / exclude a point")).toEqual(["Click", "Shift+click"]);
    expect(entry("Discard the selection")).toEqual(["Escape", "Right click"]);
    expect(keyLabel("Shift+click")).toBe("Shift+click");
    // spec 054 criterion 9
    expect(entry("Fill")).toEqual(["f"]);
    expect(entry("Polygon")).toEqual(["l"]);
    expect(entry("Fill the polygon")).toEqual(["Enter", "Double click"]);
    expect(entry("Remove the last corner")).toEqual(["Backspace", "Right click"]);
    expect(entry("Discard the polygon")).toEqual(["Escape"]);
    expect(isSingleKey("Double click")).toBe(false);
    expect(isSingleKey("Click")).toBe(false);
    expect([...new Set(SHORTCUTS.map((s) => s.section))]).toEqual(["Tools", "Brush", "Classes", "View", "Navigation", "Edit"]);
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(19);
  });
});

describe("buttons named by SHORTCUTS", () => {
  const ids = SHORTCUTS.flatMap((s) => (s.button ? [s.button] : []));

  const label = (mac: boolean) => {
    const doc = new FakeDocument();
    const els = new Map<string, FakeElement>(ids.map((id) => [id, doc.createElement("button")]));
    labelButtons((id) => (els.get(id) ?? null) as unknown as HTMLElement | null, mac);
    return els;
  };

  it("get a title ending in (<key>) and aria-keyshortcuts", () => {
    const els = label(false);
    expect(els.get("mode-paint")!.title.split("\n")[0]).toBe("Paint (B)");
    expect(els.get("mode-paint")!.getAttribute("aria-keyshortcuts")).toBe("B");
    expect(els.get("mode-pan")!.getAttribute("aria-keyshortcuts")).toBe("P Escape");
    for (const id of ids) {
      expect(els.get(id)!.title.split("\n")[0], id).toMatch(/ \(.+\)$/);
      expect(els.get(id)!.getAttribute("aria-keyshortcuts"), id).toBeTruthy();
    }
  });

  // Spec 057 criterion 2: the platform is passed in, never read from the host
  it("Undo and Redo read Ctrl off Mac and Cmd on Mac", () => {
    const off = label(false);
    expect(off.get("redo")!.title.split("\n")[0]).toBe("Redo (Ctrl+Shift+Z)");
    expect(off.get("redo")!.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+Z Control+Y");
    expect(off.get("undo")!.title.split("\n")[0]).toBe("Undo (Ctrl+Z)");
    const on = label(true);
    expect(on.get("redo")!.title.split("\n")[0]).toBe("Redo (Cmd+Shift+Z)");
    expect(on.get("redo")!.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+Z Control+Y");
    expect(on.get("undo")!.title.split("\n")[0]).toBe("Undo (Cmd+Z)");
  });

  // Spec 057 criterion 3
  it("a title is <action> (<first key>), then a newline and the hint only when there is one", () => {
    for (const mac of [false, true]) {
      const els = label(mac);
      for (const s of SHORTCUTS.filter((x) => x.button)) {
        const title = els.get(s.button!)!.title;
        expect(title, s.id).toBe(`${s.action} (${keyLabel(s.keys[0]!, mac)})${s.hint ? `\n${s.hint}` : ""}`);
        if (!s.hint) expect(title, s.id).not.toContain("\n");
      }
    }
  });
});

// Spec 057 criterion 9: Gage's four hint texts; every other hint as on main. Spec 058 criterion 9 supersedes the erase hint.
describe("hints", () => {
  const hint = (id: string) => SHORTCUTS.find((s) => s.id === id)?.hint;

  it("paint, erase, smart and fill read as Gage set them", () => {
    expect(hint("paint")).toBe("Left Drag: paints the selected class\nRight Drag: removes the selected class");
    expect(hint("erase")).toBe("Removes any label under the brush");
    expect(hint("smart")).toBe("Click an object to create an AI-generated mask. More clicks add to it, Shift+click excludes, Enter applies.");
    expect(hint("fill")).toBe("Click an area to change every connected pixel of the same class to the selected class.");
  });

  it("#mode-paint's title is the key line, then one line per hint line", () => {
    const el = new FakeDocument().createElement("button");
    labelButtons((id) => (id === "mode-paint" ? el : null) as unknown as HTMLElement | null, false);
    expect(el.title.split("\n")).toEqual(["Paint (B)", "Left Drag: paints the selected class", "Right Drag: removes the selected class"]);
  });

  it("no hint has a space beside a line break, and the others are unchanged", () => {
    for (const s of SHORTCUTS) if (s.hint) expect(s.hint, s.id).not.toMatch(/ \n|\n /);
    const others: Record<string, string> = {
      pan: "Drag to move the map. A middle drag or WASD pans in any mode.",
      "smart-apply": "Paints the previewed mask as the selected class.",
      polygon: "Click corners around a region; Enter, a double click or a click on the first corner fills it. Backspace or right click removes a corner, Escape discards.",
      "brush-smaller": "Halves the brush (in raster pixels).",
      "brush-larger": "Doubles the brush (in raster pixels).",
      help: "Lists every keyboard and mouse shortcut.",
      undo: "Takes back the last stroke, fill or applied selection.",
      redo: "Puts back what you undid.",
    };
    const changed = ["paint", "erase", "smart", "fill"];
    expect(SHORTCUTS.filter((s) => s.hint && !changed.includes(s.id)).map((s) => s.id).sort()).toEqual(Object.keys(others).sort());
    for (const [id, h] of Object.entries(others)) expect(hint(id), id).toBe(h);
  });
});

// Spec 045 criteria 5 and 6.
describe("Mac modifiers and stable ids", () => {
  it("Mod reads Cmd on Mac and Ctrl elsewhere; aria writes Meta or Control; Ctrl stays Ctrl", () => {
    expect(keyLabel("Mod+Z", true)).toBe("Cmd+Z");
    expect(keyLabel("Mod+Z", false)).toBe("Ctrl+Z");
    expect(ariaKey("Mod+Shift+Z", true)).toBe("Meta+Shift+Z");
    expect(ariaKey("Mod+Shift+Z", false)).toBe("Control+Shift+Z");
    expect(keyLabel("Ctrl+Y", true)).toBe("Ctrl+Y");
    expect(keyLabel("b", true)).toBe("B");
  });

  it("ids are unique and every KEYMAP value is one", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of Object.values(KEYMAP)) expect(ids, v).toContain(v);
  });
});
