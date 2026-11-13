import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrushMode } from "../../../src/map/brush";
import { initKinds, KINDS, type KindId, type LabelKind } from "../../../src/ui/kinds";
import { FakeDocument, type FakeElement } from "../helpers/fakeDom";

// Spec 062 criteria 1-3. A fake two-kind registry over fake DOM; the ids are cast, since KindId has only "mask" here.
type El = FakeElement & { hidden?: boolean };
const A = { id: "a", name: "A", modes: ["paint", "erase"], groups: ["tools-a", "brush-a"], sections: ["view-a"] };
const B = { id: "b", name: "B", modes: ["fill"], groups: ["tools-b"], sections: ["view-b"] };
const fake = (...kinds: object[]) => kinds as unknown as readonly LabelKind[];
const id = (k: string) => k as KindId;

function harness(kinds: readonly LabelKind[], start: BrushMode = "pan") {
  const doc = new FakeDocument();
  const els = new Map<string, El>();
  for (const k of kinds) for (const g of [...k.groups, ...k.sections]) els.set(g, doc.createElement("div"));
  const box: El = doc.createElement("div");
  box.hidden = true;
  els.set("kinds", box);
  vi.stubGlobal("document", {
    getElementById: (i: string) => els.get(i) ?? box.querySelectorAll("button").find((b) => b.getAttribute("id") === i) ?? null,
    createElement: (t: string) => doc.createElement(t),
  });
  let mode = start;
  const setMode = vi.fn((m: BrushMode) => { mode = m; });
  const k = initKinds({ kinds, mode: () => mode, setMode });
  const hidden = (i: string) => els.get(i)!.hidden === true;
  const checked = (i: string) => box.querySelectorAll("button").find((b) => b.getAttribute("id") === `kind-${i}`)!.getAttribute("aria-checked");
  return { k, box, hidden, checked, setMode, setModeTo: (m: BrushMode) => { mode = m; } };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("kinds switching (criterion 1)", () => {
  it("setKind('b') hides a's groups and sections and shows b's; aria-checked follows", () => {
    const h = harness(fake(A, B));
    expect(h.k.kind()).toBe("a");
    expect(["tools-a", "brush-a", "view-a"].map(h.hidden)).toEqual([false, false, false]);
    expect(["tools-b", "view-b"].map(h.hidden)).toEqual([true, true]);
    expect([h.checked("a"), h.checked("b")]).toEqual(["true", "false"]);
    h.k.setKind(id("b"));
    expect(h.k.kind()).toBe("b");
    expect(["tools-a", "brush-a", "view-a"].map(h.hidden)).toEqual([true, true, true]);
    expect(["tools-b", "view-b"].map(h.hidden)).toEqual([false, false]);
    expect([h.checked("a"), h.checked("b")]).toEqual(["false", "true"]);
  });

  it("renders one radio per kind, and #kinds shows only with two or more kinds", () => {
    const two = harness(fake(A, B));
    expect(two.box.querySelectorAll("button[role=radio]").map((b) => b.getAttribute("id"))).toEqual(["kind-a", "kind-b"]);
    expect(two.box.hidden).toBe(false);
    vi.unstubAllGlobals();
    const one = harness(fake(A));
    expect(one.box.querySelectorAll("button[role=radio]")).toHaveLength(1);
    expect(one.box.hidden).toBe(true);
  });

  it("clicking a kind's radio switches to it", () => {
    const h = harness(fake(A, B));
    h.box.querySelectorAll("button")[1]!.click();
    expect(h.k.kind()).toBe("b");
  });
});

describe("kinds and modes (criterion 2)", () => {
  it("follow with a mode of b while in a switches to b", () => {
    const h = harness(fake(A, B));
    h.k.follow("fill");
    expect(h.k.kind()).toBe("b");
    expect(h.hidden("tools-b")).toBe(false);
    h.k.follow("pan");
    h.k.follow("smart");
    expect(h.k.kind()).toBe("b");
  });

  it("setKind('b') in a mode of a calls setMode('pan')", () => {
    const h = harness(fake(A, B), "erase");
    h.k.setKind(id("b"));
    expect(h.setMode).toHaveBeenCalledWith("pan");
  });

  it("in Pan or Smart the mode is kept", () => {
    for (const m of ["pan", "smart"] as const) {
      const h = harness(fake(A, B), m);
      h.k.setKind(id("b"));
      h.k.setKind(id("a"));
      expect(h.setMode).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("kindOf names a mode's kind, and null for the shared Pan and Smart", () => {
    const h = harness(fake(A, B));
    expect([h.k.kindOf("paint"), h.k.kindOf("fill"), h.k.kindOf("pan"), h.k.kindOf("smart")]).toEqual(["a", "b", null, null]);
  });
});

describe("the real KINDS (criterion 3)", () => {
  const ALL: BrushMode[] = ["paint", "erase", "pan", "smart", "fill", "polygon"];

  it("every BrushMode is pan, smart, or in exactly one kind's modes", () => {
    for (const m of ALL) {
      const owners = KINDS.filter((k) => k.modes.includes(m)).length;
      expect(owners, m).toBe(m === "pan" || m === "smart" ? 0 : 1);
    }
    expect(KINDS.flatMap((k) => k.modes).every((m) => ALL.includes(m))).toBe(true);
  });

  it("has the one Masks kind of scope 1", () => {
    expect(KINDS).toEqual([{ id: "mask", name: "Masks", modes: ["paint", "erase", "fill", "polygon"], groups: ["tools-mask", "brush-group"], sections: ["mask-view"] }]);
  });

  it("every group and section id exists in index.html, marked with its kind", () => {
    const html = readFileSync("index.html", "utf8");
    for (const k of KINDS) for (const g of [...k.groups, ...k.sections]) expect(html, g).toMatch(new RegExp(`id="${g}"[^>]*data-kind="${k.id}"`));
    expect(html).toMatch(/<div id="kinds" role="radiogroup" aria-label="Label type" hidden><\/div>\s*<button id="mode-pan"/);
  });
});
