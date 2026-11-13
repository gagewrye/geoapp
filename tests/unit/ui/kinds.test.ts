import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrushMode } from "../../../src/map/brush";
import { initKinds, type KindId, type LabelKind } from "../../../src/ui/kinds";
import { FakeDocument, type FakeElement } from "../helpers/fakeDom";

// Spec 062: the kind switch spec 064 builds on. A fake two-kind registry over fake DOM; ids are cast, as KindId is only "mask".
afterEach(() => { vi.unstubAllGlobals(); });

describe("initKinds", () => {
  it("setKind shows only its kind's groups and sections, follow switches to a mode's kind, and leaving a kind's mode selects Pan", () => {
    const kinds = [
      { id: "a", name: "A", modes: ["paint"], groups: ["tools-a"], sections: ["view-a"] },
      { id: "b", name: "B", modes: ["fill"], groups: ["tools-b"], sections: ["view-b"] },
    ] as unknown as readonly LabelKind[];
    const doc = new FakeDocument();
    const els = new Map<string, FakeElement & { hidden?: boolean }>(["kinds", "tools-a", "view-a", "tools-b", "view-b"].map((i) => [i, doc.createElement("div")]));
    vi.stubGlobal("document", { getElementById: (i: string) => els.get(i) ?? null, createElement: (t: string) => doc.createElement(t) });
    let mode: BrushMode = "paint";
    const setMode = vi.fn((m: BrushMode) => { mode = m; });
    const k = initKinds({ kinds, mode: () => mode, setMode });
    const hidden = () => ["tools-a", "view-a", "tools-b", "view-b"].map((i) => els.get(i)!.hidden);
    expect(hidden()).toEqual([false, false, true, true]);
    expect(els.get("kinds")!.hidden).toBe(false); // two kinds: the switch shows
    k.setKind("b" as KindId);
    expect(hidden()).toEqual([true, true, false, false]);
    expect(setMode).toHaveBeenCalledWith("pan"); // Paint is a's
    mode = "paint"; // as ui/modes.ts setMode does, before it calls follow
    k.follow("paint");
    expect(k.kind()).toBe("a");
    k.follow("smart"); // shared: no switch
    expect(k.kind()).toBe("a");
  });
});
