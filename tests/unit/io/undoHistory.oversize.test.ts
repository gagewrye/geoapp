import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { UNDO_BYTES } from "../../../src/core/undo";
import { UndoHistory } from "../../../src/io/undoHistory";

// Spec 048 criterion 6: one edit over the undo budget keeps its own copies, and only it.
const MiB = 2 ** 20, TILE = 65536;
const keysOf = (n: number, from = 0) => tileWindows(256 * 25, 256 * 25).slice(from, from + n).map((w) => `${w.x0},${w.y0}`);
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b));
const snapshot = (s: LabelStore, keys: string[]) => new Map(keys.map((k) => [k, s.tiles.get(k)!.slice()]));

/** One ended stroke that writes value into the keys' tiles, recording one tile per move as the paint queue does; returns the peak bytes(). */
function stroke(h: UndoHistory, s: LabelStore, keys: string[], value: number): number {
  const e = h.begin();
  let peak = 0;
  for (const k of keys) {
    h.queued(e);
    h.record(e, [k]);
    const t = s.tiles.get(k) ?? new Uint8Array(TILE);
    t.fill(value, 0, 64);
    s.tiles.set(k, t);
    h.applied(e);
    peak = Math.max(peak, h.bytes());
  }
  h.end(e);
  return Math.max(peak, h.bytes());
}

describe("an oversized edit (spec 048 criterion 6)", () => {
  it("drops the ten 1 MiB entries, stays the only entry, undoes and redoes byte-equal, and a later stroke drops it", () => {
    const s = emptyStore(256 * 25, 256 * 25); // 625 tiles
    const h = new UndoHistory(() => s);
    const big = keysOf(600);
    for (const k of big) s.tiles.set(k, new Uint8Array(TILE).fill(1));
    for (let i = 0; i < 10; i++) stroke(h, s, keysOf(16, 16 * i), 10 + i);
    expect(h.size).toBe(10);
    expect(h.bytes()).toBe(10 * MiB);
    const before = snapshot(s, big);

    const limit = 600 * TILE; // 37.5 MiB
    expect(limit).toBeGreaterThan(UNDO_BYTES);
    expect(stroke(h, s, big, 7)).toBeLessThanOrEqual(limit);
    expect(h.size).toBe(1);
    expect(h.bytes()).toBe(limit);
    const after = snapshot(s, big);

    expect(h.undo()).toHaveLength(600);
    expect(h.bytes()).toBeLessThanOrEqual(limit);
    expect(big.every((k) => same(s.tiles.get(k), before.get(k)))).toBe(true);
    expect(h.redoSize).toBe(1);
    expect(h.redo()).toHaveLength(600);
    expect(h.bytes()).toBeLessThanOrEqual(limit);
    expect(big.every((k) => same(s.tiles.get(k), after.get(k)))).toBe(true);
    expect(h.size).toBe(1);

    stroke(h, s, keysOf(1), 3); // a stored tile, so its copy is 64 KiB
    expect(h.size).toBe(1);
    expect(h.bytes()).toBe(TILE);
  });
});
