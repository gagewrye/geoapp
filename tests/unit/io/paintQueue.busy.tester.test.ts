import { describe, expect, it } from "vitest";
import { emptyStore } from "../../../src/core/labelStore";
import { footprint } from "../../../src/core/pixel";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import type { RasterSource } from "../../../src/io/source";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

// Tester pass 4: spec 003 Storage / Imagery nodata ("Train is disabled while any are queued") after the
// review fix that the queue reports idle when brush throws on its last cell. busy events must alternate
// true/false and end matching whether cells are queued, whatever fails and wherever it fails.

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(failRead: (n: number) => boolean = () => false) {
  const { source: inner } = fakeSource({ width: 2048, height: 2048, nodata: -1 }, () => 5);
  let n = 0, inFlight = 0, maxInFlight = 0;
  const source: RasterSource = {
    meta: inner.meta,
    async readWindow(x0, y0, w, h) {
      const i = n++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await tick();
        if (failRead(i)) throw new Error(`read ${i} failed`);
        return await inner.readWindow(x0, y0, w, h);
      } finally { inFlight--; }
    },
  };
  const store = emptyStore(2048, 2048);
  const busy: boolean[] = [], errors: string[] = [];
  const q = new PaintQueue(source, () => store, {
    applied() {}, full() {}, busy: (b) => { busy.push(b); }, error: (e) => { errors.push((e as Error).message); },
  });
  const dab = (c: number, r: number) => footprint(store, c, r, 7)!;
  return { q, store, busy, errors, dab, get maxInFlight() { return maxInFlight; } };
}

/** busy events alternate, starting with true. */
const alternates = (busy: boolean[]) => busy.every((b, i) => b === (i % 2 === 0));

describe("paint queue busy state (tester pass 4)", () => {
  it("a throw on a middle cell drops the rest, reports idle once and the queue keeps working", async () => {
    const s = setup();
    s.q.push(cellOp(s.dab(10, 10), 1, false));
    s.q.push(cellOp(s.dab(12, 10), 0, false)); // brush throws on value 0
    s.q.push(cellOp(s.dab(600, 600), 1, false));
    await idle(s.q);
    expect(s.errors).toHaveLength(1);
    expect(s.busy).toEqual([true, false]);
    expect(s.q.masks.size).toBe(8); // band 0's 8 windows: masks stay for the raster's life (spec 023, ADR 0021)
    expect([...s.store.tiles.keys()]).toEqual(["0,0"]); // the first cell applied, the third was dropped
    s.q.push(cellOp(s.dab(600, 600), 1, false));
    await idle(s.q);
    expect(s.busy).toEqual([true, false, true, false]);
    expect([...s.store.tiles.keys()].sort()).toEqual(["0,0", "512,512"]);
  });

  it("a failed mask read drops the queue and reports idle once", async () => {
    const s = setup((n) => n === 1);
    s.q.push(cellOp(s.dab(10, 10), 1, false));
    s.q.push(cellOp(s.dab(600, 600), 1, false));
    s.q.push(cellOp(s.dab(900, 900), 1, false));
    await idle(s.q);
    expect(s.errors).toEqual(["read 1 failed"]);
    expect(s.busy).toEqual([true, false]);
    expect(s.q.size).toBe(0);
  });

  it("a synchronous throw on the only erase cell inside push leaves the queue idle and runnable", () => {
    const s = setup();
    s.q.push(cellOp(s.dab(10, 10), 0, true));
    expect(s.errors).toHaveLength(1);
    expect(s.busy).toEqual([true, false]);
    s.store.tiles.set("0,0", new Uint8Array(65536).fill(1));
    s.q.push(cellOp(s.dab(10, 10), 1, true)); // erase reads nothing: applies at once
    expect(s.store.tiles.get("0,0")![10 * 256 + 10]).toBe(0);
    expect(s.busy).toEqual([true, false, true, false]);
  });

  it("random pushes, throws, read failures and clears: busy alternates and ends equal to size > 0", { timeout: 30_000 }, async () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let run = 0; run < 40; run++) {
      const s = setup(() => rnd() < 0.1);
      for (let i = 0; i < 30; i++) {
        const x = rnd();
        if (x < 0.05) s.q.clear();
        else if (x < 0.15) await tick();
        else s.q.push(cellOp(s.dab(Math.floor(rnd() * 2048), Math.floor(rnd() * 2048)), rnd() < 0.1 ? 0 : 1, rnd() < 0.3));
        expect(alternates(s.busy)).toBe(true);
      }
      await idle(s.q);
      await tick();
      expect(alternates(s.busy)).toBe(true);
      expect(s.busy.at(-1) ?? false).toBe(false);
    }
  });

  it("without clear(), at most one mask read is in flight, also across a thrown cell", async () => {
    const s = setup();
    for (let c = 0; c < 2048; c += 300) {
      s.q.push(cellOp(s.dab(c, c), c === 900 ? 0 : 1, false));
      s.q.push(cellOp(s.dab(2047 - c, c), 1, false));
      await tick();
    }
    await idle(s.q);
    expect(s.maxInFlight).toBe(1);
    expect(alternates(s.busy)).toBe(true);
  });
});
