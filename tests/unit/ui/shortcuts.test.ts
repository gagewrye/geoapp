import { readFileSync } from "node:fs";
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
    expect(entry("Include / exclude a point")).toEqual(["Click", "Right click"]);
    expect(entry("Discard the selection")).toEqual(["Escape"]);
    expect(isSingleKey("Click")).toBe(false);
    expect([...new Set(SHORTCUTS.map((s) => s.section))]).toEqual(["Tools", "Brush", "Classes", "View", "Navigation", "Edit"]);
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(19);
  });
});

describe("buttons named by SHORTCUTS", () => {
  const ids = SHORTCUTS.flatMap((s) => (s.button ? [s.button] : []));

  it("each exists in index.html", () => {
    const html = readFileSync("index.html", "utf8");
    expect(ids.length).toBeGreaterThanOrEqual(7);
    for (const id of ids) expect(html, id).toContain(`id="${id}"`);
  });

  it("get a title ending in (<key>) and aria-keyshortcuts", () => {
    const doc = new FakeDocument();
    const els = new Map<string, FakeElement>(ids.map((id) => [id, doc.createElement("button")]));
    labelButtons((id) => (els.get(id) ?? null) as unknown as HTMLElement | null);
    expect(els.get("mode-paint")!.title).toBe("Paint (B)");
    expect(els.get("mode-paint")!.getAttribute("aria-keyshortcuts")).toBe("B");
    expect(els.get("mode-pan")!.getAttribute("aria-keyshortcuts")).toBe("P Escape");
    expect(els.get("redo")!.title).toBe("Redo (Ctrl+Shift+Z)");
    expect(els.get("redo")!.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+Z Control+Y");
    for (const id of ids) {
      expect(els.get(id)!.title, id).toMatch(/ \(.+\)$/);
      expect(els.get(id)!.getAttribute("aria-keyshortcuts"), id).toBeTruthy();
    }
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

  it("labelKeys.ts and help.ts branch on ids: no string literal in them equals an action", () => {
    const actions = new Set(SHORTCUTS.map((s) => s.action));
    for (const f of ["src/ui/labelKeys.ts", "src/ui/help.ts"]) {
      const literals = [...readFileSync(f, "utf8").matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
      expect(literals.filter((l) => actions.has(l!)), f).toEqual([]);
    }
  });
});
