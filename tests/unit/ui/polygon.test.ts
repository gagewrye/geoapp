import { describe, expect, it } from "vitest";
import { emptyStore } from "../../../src/core/labelStore";
import { polygonSpans } from "../../../src/core/polygon";
import type { PaintOp } from "../../../src/io/paintQueue";
import { UndoHistory } from "../../../src/io/undoHistory";
import { MESSAGES } from "../../../src/ui/messages";
import { initPolygon } from "../../../src/ui/polygon";

// Spec 054 criterion 6.
type P = [number, number];
function setup(o: { lands?: boolean } = {}) {
  const store = emptyStore(5000, 4000), history = new UndoHistory(() => store);
  const shown: (P[] | null)[] = [], ops: PaintOp[] = [], said: string[] = [];
  const state = { locked: false, applied: 0, now: 1000 };
  const polygon = initPolygon({
    dims: () => store, near: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 3, show: (c) => shown.push(c && c.map((p) => [...p] as P)),
    push: (op) => { ops.push(op); if (o.lands) op.done!("ok"); }, history, now: () => state.now, value: () => 2, locked: () => state.locked, applied: () => { state.applied++; }, say: (t) => said.push(t),
  });
  return { polygon, shown, ops, said, state, history };
}
const TRI: P[] = [[100, 100], [200, 100], [150, 180]];

describe("the polygon's corners", () => {
  it("each click adds a corner and shows the outline; fewer than 3 don't apply", () => {
    const t = setup();
    t.polygon.click(TRI[0]!);
    t.polygon.click(TRI[1]!);
    expect(t.shown).toEqual([[TRI[0]], [TRI[0], TRI[1]]]);
    expect(t.polygon.apply()).toBe(false);
    expect(t.ops).toEqual([]);
  });

  it("apply pushes one op of polygonSpans with the selected value as one ended stroke, and the outline goes once it lands", () => {
    const t = setup();
    for (const p of TRI) t.polygon.click(p);
    expect(t.polygon.apply()).toBe(true);
    expect(t.ops).toHaveLength(1);
    const op = t.ops[0]!;
    expect(op.spans).toEqual(polygonSpans(TRI, { width: 5000, height: 4000 }));
    expect([op.value, op.erase, op.stroke?.ended]).toEqual([2, false, true]);
    expect(t.state.applied).toBe(1);
    expect(t.polygon.corners()).toBe(3); // still shown while the fill waits for its tiles
    expect(t.polygon.apply()).toBe(false); // and not applied twice
    op.done!("ok");
    expect(t.polygon.corners()).toBe(0);
    expect(t.shown.at(-1)).toBeNull();
  });

  it("a click on the first corner, or on the last (a double click), applies; with fewer than 3 a repeated click adds nothing", () => {
    for (const close of [[101, 99], [151, 181]] as P[]) {
      const t = setup();
      t.polygon.click(TRI[0]!);
      t.polygon.click([101, 101]); // a double click's second press
      expect(t.polygon.corners()).toBe(1);
      t.polygon.click(TRI[1]!);
      t.polygon.click(TRI[2]!);
      t.polygon.click(close);
      expect(t.ops).toHaveLength(1);
      expect(t.ops[0]!.spans).toEqual(polygonSpans(TRI, { width: 5000, height: 4000 }));
    }
  });

  it("a fill that lands inside push: a double click on the first or last corner leaves no stray corner, and a later click starts a new outline", () => {
    for (const close of [TRI[0]!, TRI[2]!]) {
      const t = setup({ lands: true });
      for (const p of TRI) t.polygon.click(p);
      t.polygon.click(close); // the double click's first press closes and the fill lands at once
      expect([t.ops.length, t.polygon.corners()]).toEqual([1, 0]);
      t.state.now += 120;
      t.polygon.click(close); // its second press
      expect(t.polygon.corners()).toBe(0);
      t.polygon.click(close); // a third click, no longer the double click
      expect(t.polygon.corners()).toBe(1);
    }
    // a click elsewhere, or at the same place after the double-click time, is a new corner at once
    const far = setup({ lands: true });
    for (const p of [...TRI, TRI[0]!]) far.polygon.click(p);
    far.polygon.click([400, 400]);
    expect(far.polygon.corners()).toBe(1);
    const late = setup({ lands: true });
    for (const p of [...TRI, TRI[0]!]) late.polygon.click(p);
    late.state.now += 600;
    late.polygon.click(TRI[0]!);
    expect(late.polygon.corners()).toBe(1);
  });

  it("back removes the last corner, discard them all, and each is false with none", () => {
    const t = setup();
    expect([t.polygon.back(), t.polygon.discard()]).toEqual([false, false]);
    for (const p of TRI) t.polygon.click(p);
    expect(t.polygon.back()).toBe(true);
    expect(t.shown.at(-1)).toEqual(TRI.slice(0, 2));
    expect(t.polygon.discard()).toBe(true);
    expect(t.shown.at(-1)).toBeNull();
    expect(t.polygon.corners()).toBe(0);
  });

  it("refuses a corner that would span more than 2048 px, with a message, and keeps the rest", () => {
    const t = setup();
    t.polygon.click([100, 100]);
    t.polygon.click([100 + 2048, 100]);
    expect(t.said).toEqual([MESSAGES.polygonTooLarge]);
    expect(t.polygon.corners()).toBe(1);
    t.polygon.click([100 + 2047, 100]);
    expect(t.polygon.corners()).toBe(2);
  });

  it("doesn't apply while the labels are locked, and a dropped fill keeps the outline", () => {
    const t = setup();
    for (const p of TRI) t.polygon.click(p);
    t.state.locked = true;
    expect(t.polygon.apply()).toBe(false);
    t.state.locked = false;
    expect(t.polygon.apply()).toBe(true);
    t.ops[0]!.done!("dropped");
    expect(t.polygon.corners()).toBe(3);
    expect(t.polygon.apply()).toBe(true);
  });

  it("a discard while a fill lands keeps the next outline; opening a raster drops everything", () => {
    const t = setup();
    for (const p of TRI) t.polygon.click(p);
    t.polygon.apply();
    t.polygon.click([500, 500]); // ignored while the fill lands
    expect(t.polygon.corners()).toBe(3);
    t.polygon.discard();
    t.ops[0]!.done!("ok");
    t.polygon.click([500, 500]);
    expect(t.polygon.corners()).toBe(1);
    t.polygon.open();
    expect(t.polygon.corners()).toBe(0);
  });
});
