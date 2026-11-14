import { describe, expect, it } from "vitest";
import { emptyStore } from "../../../src/core/labelStore";
import { UndoHistory } from "../../../src/io/undoHistory";
import type { BoxGesture } from "../../../src/map/boxTool";
import { initBoxes } from "../../../src/ui/boxes";
import type { KindId } from "../../../src/ui/kinds";
import { BRUSH_GRID } from "../helpers/fakeBrushMap";

// Spec 064 criteria 1 and 3: ui/boxes over a fake layer and a real history.
function setup() {
  const state = { blocked: false, value: 1, boxMode: true, kind: "box" as KindId };
  const calls: string[] = [];
  const layer = {
    open: () => { calls.push("open"); }, show: () => { calls.push("show"); }, edit: () => { calls.push("edit"); }, visible: () => {},
  };
  // eslint-disable-next-line prefer-const -- the history reads the store initBoxes makes
  let bx: ReturnType<typeof initBoxes>;
  const history = new UndoHistory(() => emptyStore(50, 50), () => bx.store());
  bx = initBoxes({ layer, history: () => history, colours: () => ["#f00", "#0f0"], value: () => state.value, boxMode: () => state.boxMode,
    kind: () => state.kind, blocked: () => state.blocked, changed: () => {} });
  bx.open(BRUSH_GRID);
  const g = bx.gestures;
  const drag = (gesture: BoxGesture, to: [number, number]) => { g.start(gesture); g.drag(to); g.end(to); };
  const boxes = () => [...bx.store().boxes.values()];
  return { bx, g, history, state, calls, drag, boxes };
}

describe("ui/boxes edits (criterion 1)", () => {
  it("a drawn box is one box with the selected value, selected, and one entry; the release sets the boxes once", () => {
    const t = setup();
    t.state.value = 2;
    t.calls.length = 0;
    t.g.start({ kind: "draw", from: [10, 10] });
    for (const c of [[20, 15], [30, 25], [40, 30]] as [number, number][]) t.g.drag(c);
    expect(t.calls).toEqual(["edit", "edit", "edit"]);
    t.g.end([40, 30]);
    expect(t.calls.filter((c) => c === "show")).toEqual(["show"]);
    expect(t.boxes()).toEqual([{ id: 1, value: 2, x0: 10, y0: 10, x1: 41, y1: 31 }]);
    expect(t.g.selected()).toEqual(t.boxes()[0]);
    expect(t.history.size).toBe(1);
  });

  it("Escape mid-drag adds nothing, and a move by 0 px adds no entry", () => {
    const t = setup();
    t.g.start({ kind: "draw", from: [10, 10] });
    t.g.drag([20, 20]);
    expect(t.bx.dragging()).toBe(true);
    expect(t.bx.keys.escape()).toBe(true);
    t.g.end([20, 20]); // the release after the cancel
    expect(t.boxes()).toEqual([]);
    expect(t.history.size).toBe(0);
    t.drag({ kind: "draw", from: [10, 10] }, [20, 20]);
    t.drag({ kind: "move", from: [15, 15] }, [15, 15]);
    expect(t.history.size).toBe(1);
    t.drag({ kind: "move", from: [15, 15] }, [18, 13]);
    t.drag({ kind: "resize", handle: "se", from: [20, 18] }, [30, 30]);
    expect(t.boxes()).toEqual([{ id: 1, value: 1, x0: 13, y0: 8, x1: 31, y1: 31 }]);
    expect(t.history.size).toBe(3);
  });

  it("Delete and a class change are each one entry, and choosing the box's own class adds none", () => {
    const t = setup();
    t.drag({ kind: "draw", from: [10, 10] }, [20, 20]);
    t.bx.classChosen(0); // its own class
    expect(t.history.size).toBe(1);
    t.bx.classChosen(1);
    expect(t.boxes()[0]!.value).toBe(2);
    expect(t.history.size).toBe(2);
    expect(t.bx.keys.remove()).toBe(true);
    expect(t.boxes()).toEqual([]);
    expect(t.g.selected()).toBeNull();
    expect(t.history.size).toBe(3);
    expect(t.bx.keys.remove()).toBe(false); // nothing selected
    t.history.undo();
    t.history.undo();
    expect(t.boxes()[0]!.value).toBe(1);
  });

  it("locked or peeking, a draw, move, Escape, Delete, class change and click each do nothing", () => {
    const t = setup();
    t.drag({ kind: "draw", from: [10, 10] }, [20, 20]);
    const before = t.boxes();
    t.state.blocked = true;
    t.drag({ kind: "draw", from: [30, 30] }, [40, 40]);
    t.drag({ kind: "move", from: [15, 15] }, [18, 18]);
    t.bx.classChosen(1);
    expect(t.bx.keys.remove()).toBe(false);
    expect(t.bx.keys.escape()).toBe(false);
    t.g.click([45, 45]);
    expect(t.boxes()).toEqual(before);
    expect(t.g.selected()).toEqual(before[0]);
    expect(t.history.size).toBe(1);
  });
});

describe("ui/boxes selection (criterion 3, scope 3)", () => {
  it("a click cycles through nested boxes, and a click on no box clears the selection", () => {
    const t = setup();
    t.drag({ kind: "draw", from: [0, 0] }, [40, 40]);
    t.drag({ kind: "draw", from: [10, 10] }, [20, 20]);
    const [outer, inner] = t.boxes();
    for (const want of [inner, outer, inner]) { t.g.click([12, 12]); expect(t.g.selected()).toEqual(want); }
    t.g.click([45, 45]);
    expect(t.g.selected()).toBeNull();
  });

  it("an undo that removes the selected box clears it; Masks clear it; outside Box mode drags edit nothing", () => {
    const t = setup();
    t.drag({ kind: "draw", from: [10, 10] }, [20, 20]);
    const [id] = t.history.undo()!.boxes;
    t.bx.undone([id!]);
    expect(t.bx.size()).toBeNull();
    t.history.redo();
    t.g.click([12, 12]);
    expect(t.bx.size()).toEqual([11, 11]);
    t.state.boxMode = false; // Pan, still in Boxes
    t.bx.modeChanged();
    expect(t.g.selected()).toBeNull(); // no handles or drags outside Box mode
    expect(t.bx.size()).toEqual([11, 11]);
    t.drag({ kind: "draw", from: [30, 30] }, [40, 40]);
    expect(t.boxes().length).toBe(1);
    t.state.kind = "mask";
    t.bx.modeChanged();
    expect(t.bx.size()).toBeNull();
  });
});

describe("ui/boxes under a lock that starts mid-drag", () => {
  it("cancels the drag, so its release adds nothing", () => {
    const t = setup();
    t.g.start({ kind: "draw", from: [10, 10] });
    t.g.drag([20, 20]);
    t.state.blocked = true;
    t.g.end([30, 30]);
    expect(t.bx.dragging()).toBe(false);
    expect(t.boxes()).toEqual([]);
    expect(t.history.size).toBe(0);
  });
});
