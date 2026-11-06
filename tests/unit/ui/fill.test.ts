import { describe, expect, it } from "vitest";
import { emptyStore } from "../../../src/core/labelStore";
import type { FillRead } from "../../../src/io/fill";
import type { PaintOp } from "../../../src/io/paintQueue";
import { UndoHistory } from "../../../src/io/undoHistory";
import { initFill } from "../../../src/ui/fill";
import { MESSAGES } from "../../../src/ui/messages";

// Spec 054 criterion 5. A 600 x 300 raster: label 1 left of column 300, 2 right of it, all valid.
function setup(o: { width?: number; fail?: boolean; nodata?: boolean } = {}) {
  const store = emptyStore(o.width ?? 600, 300), history = new UndoHistory(() => store);
  const ops: PaintOp[] = [], said: string[] = [], errors: unknown[] = [];
  const state = { locked: false, pending: false, value: 3, changed: 0, filled: 0, reads: 0, hold: null as null | (() => void) };
  const read: FillRead = async (_k, t) => {
    state.reads++;
    if (state.hold === null) await new Promise<void>((r) => { state.hold = r; });
    if (o.fail) throw new Error("gone");
    return { labels: Uint8Array.from({ length: t.width * t.height }, (_, i) => (t.x0 + (i % t.width) < 300 ? 1 : 2)), mask: o.nodata ? "none" : "all" };
  };
  const fill = initFill({
    dims: () => store, reader: () => read, push: (op) => ops.push(op), history, value: () => state.value, locked: () => state.locked, pending: () => state.pending,
    changed: () => { state.changed++; }, filled: () => { state.filled++; }, say: (t) => said.push(t), error: (e) => errors.push(e),
  });
  /** Lets the held first read go on, and later reads straight through. */
  const release = () => { const h = state.hold; state.hold = () => {}; h?.(); };
  return { fill, ops, said, errors, state, release };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the fill tool", () => {
  it("a click pushes one op over the region with the selected value as one ended stroke, and says how much it filled", async () => {
    const t = setup();
    const done = t.fill.click([10, 10]);
    expect(t.fill.busy()).toBe(true);
    t.release();
    await done;
    expect(t.ops).toHaveLength(1);
    const op = t.ops[0]!;
    expect(op.box).toEqual({ x0: 0, y0: 0, width: 300, height: 300 });
    expect([op.value, op.erase, op.stroke?.ended]).toEqual([3, false, true]);
    expect(t.state.filled).toBe(1);
    expect(t.fill.busy()).toBe(true); // until the op lands
    op.done!("ok");
    expect(t.fill.busy()).toBe(false);
    expect(t.said).toEqual([MESSAGES.filled(90000)]);
    expect(MESSAGES.filled(90000)).toBe("Filled 90,000 px.");
    expect(t.state.changed).toBe(2); // busy, then idle
  });

  it("ignores clicks while one is read or lands, and while the labels are locked", async () => {
    const t = setup();
    const first = t.fill.click([10, 10]);
    void t.fill.click([400, 10]);
    t.release();
    await first;
    void t.fill.click([400, 10]);
    await settle();
    expect(t.ops).toHaveLength(1);
    t.ops[0]!.done!("ok");
    t.state.locked = true;
    await t.fill.click([400, 10]);
    expect(t.ops).toHaveLength(1);
    t.state.locked = false;
    await t.fill.click([400, 10]);
    expect(t.ops).toHaveLength(2);
    expect(t.ops[1]!.box).toEqual({ x0: 300, y0: 0, width: 300, height: 300 });
  });

  it("a region already of the selected class, or with no imagery, pushes nothing and says why", async () => {
    const t = setup();
    t.release();
    t.state.value = 1;
    await t.fill.click([10, 10]);
    expect(t.ops).toEqual([]);
    expect(t.said).toEqual([MESSAGES.fillSame]);
    expect(t.fill.busy()).toBe(false);
    const n = setup({ nodata: true });
    n.release();
    await n.fill.click([10, 10]);
    expect(n.ops).toEqual([]);
    expect(n.said).toEqual([MESSAGES.fillNodata]);
    expect(n.fill.busy()).toBe(false);
  });

  it("ignores a click while strokes are still queued, whose tiles it would read before they change, without a read", async () => {
    const t = setup();
    t.release();
    t.state.pending = true;
    await t.fill.click([10, 10]);
    expect([t.ops.length, t.state.reads, t.state.changed]).toEqual([0, 0, 0]);
    t.state.pending = false;
    await t.fill.click([10, 10]);
    expect(t.ops).toHaveLength(1);
  });

  it("a cancel mid-read pushes nothing and leaves it idle, and the next click runs", async () => {
    const t = setup();
    const first = t.fill.click([10, 10]);
    t.fill.cancel();
    expect(t.fill.busy()).toBe(false);
    t.release();
    await first;
    expect(t.ops).toEqual([]);
    await t.fill.click([10, 10]);
    expect(t.ops).toHaveLength(1);
  });

  it("a fill cut short at its reach says so", async () => {
    const t = setup({ width: 256 * 14 });
    t.release();
    await t.fill.click([256 * 7, 10]); // label 2 runs on past 4 tiles to the right
    t.ops[0]!.done!("ok");
    expect(t.said).toEqual([MESSAGES.fillClipped(t.ops[0]!.spans.reduce((n, s) => n + s.x1 - s.x0, 0))]);
  });

  it("a failed read reports the error once and leaves it idle", async () => {
    const t = setup({ fail: true });
    t.release();
    await t.fill.click([10, 10]);
    expect(t.errors).toHaveLength(1);
    expect(t.ops).toEqual([]);
    expect(t.fill.busy()).toBe(false);
  });
});
