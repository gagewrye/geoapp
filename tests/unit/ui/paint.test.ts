import { describe, expect, it } from "vitest";
import { emptyStore } from "../../../src/core/labelStore";
import { UndoHistory } from "../../../src/io/undoHistory";
import { initPaint } from "../../../src/ui/paint";
import { fakeSource } from "../helpers/sources";

// Spec 023 F5, review finding 2: the hover's quad prefetch runs only between strokes, never while one is drawn
// or its moves wait, so idle quad work can't delay the stroke's pointer moves and frames.

const W = 2000, H = 1500;

function setup() {
  const store = emptyStore(W, H);
  const prefetched: string[][] = [];
  const state = { stroking: false };
  let gate: () => void = () => {};
  const held = new Promise<void>((r) => { gate = r; });
  const { source } = fakeSource({ width: W, height: H, nodata: 0, float: false }, () => 5);
  const read = source.readWindow.bind(source);
  source.readWindow = async (...a) => { await held; return read(...a); };
  const paint = initPaint({
    store: () => store, base: () => null, history: new UndoHistory(() => store), stroke: () => null, value: () => 1, locked: () => false,
    applied() {}, prefetch: (keys) => { prefetched.push(keys); }, say() {}, busy() {}, imageryBusy: () => false, importing: () => false,
    stroking: () => state.stroking,
  });
  paint.open(source);
  return { paint, prefetched, state, open: () => gate() };
}
const hover = { x0: 1000, y0: 700, width: 7, height: 7 };

describe("push (spec 046)", () => {
  it("an op it can't queue (no raster open) is reported dropped", () => {
    const store = emptyStore(W, H);
    const paint = initPaint({
      store: () => store, base: () => null, history: new UndoHistory(() => store), stroke: () => null, value: () => 1, locked: () => false,
      applied() {}, prefetch() {}, say() {}, busy() {}, imageryBusy: () => false, importing: () => false, stroking: () => false,
    });
    const ends: string[] = [];
    paint.push({ spans: [{ row: 0, x0: 0, x1: 1 }], box: { x0: 0, y0: 0, width: 1, height: 1 }, value: 1, erase: false, done: (r) => ends.push(r) });
    expect(ends).toEqual(["dropped"]);
  });
});

describe("hover prefetch (review 2)", () => {
  it("between strokes, a hover prefetches the 5x5 tiles around it", () => {
    const { paint, prefetched } = setup();
    paint.hovered(hover);
    expect(prefetched).toHaveLength(1);
    expect(prefetched[0]).toHaveLength(25);
  });

  it("while a stroke is drawn, a hover drops the queued tiles and prefetches none", () => {
    const { paint, prefetched, state } = setup();
    state.stroking = true;
    paint.hovered(hover);
    expect(prefetched).toEqual([[]]);
  });

  it("while moves wait for masks, a hover prefetches none; once they apply it does again", async () => {
    const { paint, prefetched, open } = setup();
    paint.cells([[1000, 700]], 7, false);
    expect(paint.size()).toBe(1);
    paint.hovered(hover);
    expect(prefetched).toEqual([[]]);
    open();
    while (paint.size()) await new Promise((r) => setTimeout(r, 5));
    paint.hovered(hover);
    expect(prefetched.at(-1)).toHaveLength(25);
  });
});
