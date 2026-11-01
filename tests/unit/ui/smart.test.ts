import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import { emptyStore } from "../../../src/core/labelStore";
import { maskBits, maskSpans, SAM_SIDE } from "../../../src/core/smart";
import type { PaintOp } from "../../../src/io/paintQueue";
import type { Masks, Segmenter } from "../../../src/io/segmenter";
import { UndoHistory } from "../../../src/io/undoHistory";
import { initSmart, type SmartMask } from "../../../src/ui/smart";

// Spec 046 criterion 3, with a fake Segmenter that returns a square around each include point.
const SIDE = 256, R = 8; // logits half-width: 32 encoder pixels

/** side² logits: 1 on squares of half-width r around the points (encoder pixels), else -1. */
function squares(points: number[], r: number, into = new Float32Array(SIDE * SIDE).fill(-1)): Float32Array {
  for (let i = 0; i < points.length; i += 2) {
    const cx = Math.floor(points[i]! / 4), cy = Math.floor(points[i + 1]! / 4);
    for (let y = Math.max(0, cy - r); y <= Math.min(SIDE - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(SIDE - 1, cx + r); x++) into[y * SIDE + x] = 1;
  }
  return into;
}

function fakeSegmenter() {
  let held: string | null = null;
  const log = { encodes: [] as string[], decodes: [] as number[][] };
  const gates: (() => void)[] = [];
  const s = {
    log,
    /** Holds every decode (and with holdEncode, every encode) until release() is called. */
    hold: false,
    holdEncode: false,
    release: () => { for (const g of gates.splice(0)) g(); },
    async encode(_input: Float32Array, key: string) {
      log.encodes.push(key);
      held = null;
      await (s.holdEncode ? new Promise<void>((r) => gates.push(r)) : Promise.resolve());
      held = key;
    },
    has: (key: string) => held === key,
    async decode(points: Float32Array, labels: Uint8Array): Promise<Masks> {
      log.decodes.push([...points]);
      if (s.hold) await new Promise<void>((r) => gates.push(r));
      // as the export does for any point count: three masks, of half-width R - 2, R and R + 2, the second scoring best
      const n = 3, masks = new Float32Array(n * SIDE * SIDE).fill(-1);
      const include = [...points].filter((_, j) => labels[j >> 1] === 1);
      for (let k = 0; k < n; k++) squares(include, R - 2 + 2 * k, masks.subarray(k * SIDE * SIDE, (k + 1) * SIDE * SIDE));
      return { masks, scores: Float32Array.from({ length: n }, (_, k) => (k === 1 ? 0.9 : 0.5)), side: SIDE };
    },
  };
  return s;
}

function setup() {
  const seg = fakeSegmenter();
  const store = emptyStore(3000, 2000);
  const history = new UndoHistory(() => store);
  const shown: (SmartMask | null)[] = [], ops: PaintOp[] = [], reads: Window[] = [];
  const smart = initSmart({
    dims: () => store, segmenter: () => seg as Segmenter,
    input: async (w) => { reads.push(w); return new Float32Array(1); },
    show: (m) => shown.push(m), push: (op) => ops.push(op), history, value: () => 2, locked: () => false,
    reading: () => {}, error: (e) => { throw e; },
  });
  return { seg, smart, shown, ops, reads, history };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const ones = (m: SmartMask | null | undefined) => (m ? m.bits.reduce((n, b) => n + b, 0) : 0);

describe("smart select prompts (criterion 3)", () => {
  it("a first click encodes once, and a second click in the window decodes without encoding", async () => {
    const { seg, smart, shown, reads } = setup();
    smart.click([1500, 1000], true);
    smart.click([1520, 1010], true); // while it encodes: decoded once the encode ends
    await settle();
    expect(seg.log.encodes).toHaveLength(1);
    expect(reads).toEqual([{ x0: 1024, y0: 512, width: SAM_SIDE, height: SAM_SIDE }]);
    expect(seg.log.decodes).toEqual([[1500.5 - 1024, 1000.5 - 512, 1520.5 - 1024, 1010.5 - 512]]);
    smart.click([1600, 1100], false);
    await settle();
    expect(seg.log.encodes).toHaveLength(1);
    expect(seg.log.decodes).toHaveLength(2);
    expect(ones(shown.at(-1))).toBeGreaterThan(0);
  });

  it("with one point, the best of three masks shows", async () => {
    const { smart, shown } = setup();
    smart.click([1500, 1000], true);
    await settle();
    const w = shown.at(-1)!.window;
    expect([...shown.at(-1)!.bits]).toEqual([...maskBits(squares([1500.5 - w.x0, 1000.5 - w.y0], R), SIDE, w)]);
  });

  it("with more points, the best-scoring mask shows too", async () => {
    const { smart, shown } = setup();
    smart.click([1500, 1000], true);
    smart.click([1600, 1100], true);
    await settle();
    const w = shown.at(-1)!.window;
    expect([...shown.at(-1)!.bits]).toEqual([...maskBits(squares([1500.5 - w.x0, 1000.5 - w.y0, 1600.5 - w.x0, 1100.5 - w.y0], R), SIDE, w)]);
  });

  it("Escape during an encode, then a click in the same window, waits for that encode instead of encoding again", async () => {
    const { seg, smart, shown } = setup();
    seg.holdEncode = true;
    smart.click([1500, 1000], true);
    await settle();
    expect(seg.log.encodes).toHaveLength(1);
    smart.discard();
    smart.click([1510, 1000], true);
    await settle();
    seg.release();
    await settle();
    expect(seg.log.encodes).toHaveLength(1);
    expect(shown.at(-1)).not.toBeNull();
  });

  it("a click outside the window starts a new prompt", async () => {
    const { seg, smart, shown } = setup();
    smart.click([1500, 1000], true);
    await settle();
    smart.click([300, 300], true);
    await settle();
    expect(seg.log.encodes).toHaveLength(2);
    expect(seg.log.decodes.at(-1)).toEqual([300.5, 300.5]); // the new prompt's point alone
    expect(shown.at(-1)!.window).toEqual({ x0: 0, y0: 0, width: SAM_SIDE, height: SAM_SIDE });
  });

  it("a decode that resolves after Escape changes nothing", async () => {
    const { seg, smart, shown, ops } = setup();
    seg.hold = true;
    smart.click([1500, 1000], true);
    await settle();
    expect(seg.log.decodes).toHaveLength(1);
    expect(smart.discard()).toBe(true);
    const n = shown.length;
    seg.release();
    await settle();
    expect(shown.slice(n).filter((m) => m !== null)).toEqual([]);
    expect(smart.apply()).toBe(false);
    expect(ops).toEqual([]);
    expect(smart.discard()).toBe(false); // no prompt left: Escape selects Pan
  });

  it("opening a raster drops the prompt and the embedding", async () => {
    const { seg, smart, shown, ops } = setup();
    smart.click([1500, 1000], true);
    await settle();
    smart.open();
    expect(shown.at(-1)).toBeNull();
    expect(smart.apply()).toBe(false);
    expect(ops).toEqual([]);
    smart.click([1500, 1000], true);
    await settle();
    expect(seg.log.encodes).toHaveLength(2);
  });

  it("Enter pushes exactly one PaintOp whose spans are maskSpans of the shown mask", async () => {
    const { smart, shown, ops, history } = setup();
    smart.click([1500, 1000], true);
    await settle();
    const m = shown.at(-1)!;
    expect(smart.apply()).toBe(true);
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.spans).toEqual(maskSpans(m.bits, m.window));
    expect([op.value, op.erase, op.stroke?.ended]).toEqual([2, false, true]);
    expect(smart.apply()).toBe(false); // the commit is pending
    op.done!("ok");
    expect(shown.at(-1)).toBeNull(); // a successful commit clears the prompt
    expect(history.size).toBe(0); // the stroke enters the history once its op applies (the fake queue never applies it)
  });

  it("a commit that hits the cap keeps the prompt", async () => {
    const { smart, ops } = setup();
    smart.click([1500, 1000], true);
    await settle();
    smart.apply();
    ops[0]!.done!("full");
    expect(smart.apply()).toBe(true);
    expect(ops).toHaveLength(2);
  });
});
