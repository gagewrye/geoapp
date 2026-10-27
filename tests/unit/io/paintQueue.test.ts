import { describe, expect, it } from "vitest";
import { footprint } from "../../../src/core/pixel";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { PaintQueue } from "../../../src/io/paintQueue";
import type { RasterSource } from "../../../src/io/source";
import { fakeSource } from "../helpers/sources";

type Read = { x0: number; y0: number; width: number; height: number };

/** Instrumented 2048x2048 source: logs reads, tracks reads in flight, and can be held. */
function instrumented(nodata: (c: number, r: number) => boolean = () => false) {
  const { source: inner, reads } = fakeSource({ width: 2048, height: 2048, nodata: -1 }, (_b, c, r) => (nodata(c, r) ? -1 : 5));
  let inFlight = 0, maxInFlight = 0;
  let gate: Promise<void> | null = null, open = () => {};
  const source: RasterSource = {
    meta: inner.meta,
    async readWindow(x0, y0, w, h) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        while (gate) await gate;
        return await inner.readWindow(x0, y0, w, h);
      } finally { inFlight--; }
    },
  };
  return {
    source, reads,
    get maxInFlight() { return maxInFlight; },
    hold() { gate = new Promise((r) => { open = () => { gate = null; r(); }; }); },
    release() { open(); },
  };
}

function queue(src: ReturnType<typeof instrumented>, store: LabelStore = emptyStore(2048, 2048)) {
  const events = { full: 0, applied: 0, busy: [] as boolean[] };
  const q = new PaintQueue(src.source, () => store, {
    applied: () => { events.applied++; },
    full: () => { events.full++; },
    busy: (b) => { events.busy.push(b); },
    error: (e) => { throw e; },
  });
  return { q, store, events };
}

const dab = (store: LabelStore, c: number, r: number, side = 7) => footprint(store, c, r, side)!;
const key = (w: Read) => `${w.x0},${w.y0}`;
const aligned = (reads: Read[]) => reads.every((w) => w.x0 % 256 === 0 && w.y0 % 256 === 0 && w.width === 256 && w.height === 256);

describe("paint reads (criterion 8)", () => {
  it("erasing reads no window", async () => {
    const src = instrumented();
    const { q, store } = queue(src);
    store.tiles.set("0,0", new Uint8Array(65536).fill(1));
    for (let c = 0; c < 600; c += 3) q.push({ w: dab(store, c, 100), value: 1, erase: true });
    await q.idle();
    expect(src.reads).toEqual([]);
    expect(store.tiles.get("0,0")![100 * 256 + 10]).toBe(0);
  });

  it("a stroke back and forth over two stored tiles reads each once, one at a time, aligned", async () => {
    const src = instrumented();
    const { q, store } = queue(src);
    for (let pass = 0; pass < 3; pass++) for (let c = 240; c <= 270; c++) q.push({ w: dab(store, pass % 2 ? 510 - c : c, 100), value: 1, erase: false });
    await q.idle();
    expect(src.reads.map(key)).toEqual(["0,0", "256,0"]);
    expect(aligned(src.reads)).toBe(true);
    expect(src.maxInFlight).toBe(1);
    expect([...store.tiles.keys()].sort()).toEqual(["0,0", "256,0"]);
  });

  it("reads only tiles a footprint meets that have no mask", async () => {
    const src = instrumented();
    const { q, store } = queue(src);
    q.push({ w: dab(store, 253, 253), value: 2, erase: false }); // a tile corner: 4 tiles
    q.push({ w: dab(store, 1000, 1000), value: 2, erase: false });
    await q.idle();
    expect(src.reads.map(key)).toEqual(["0,0", "256,0", "0,256", "256,256", "768,768"]);
    expect(src.maxInFlight).toBe(1);
  });

  it("a stroke that leaves a tile it labelled nothing in and comes back reads it again", async () => {
    // tile 256,0 is all nodata, so the stroke labels nothing there and stores no tile
    const src = instrumented((c) => c >= 256 && c < 512);
    const { q, store } = queue(src);
    const stroke = (cols: number[]) => cols.forEach((c) => q.push({ w: dab(store, c, 100), value: 1, erase: false }));
    stroke([200, 300, 400, 300]); // stays on tile 256,0: its mask is kept
    await q.idle();
    expect(src.reads.map(key)).toEqual(["0,0", "256,0"]);
    stroke([200, 300]); // leaves it (mask freed), then comes back
    await q.idle();
    expect(src.reads.map(key)).toEqual(["0,0", "256,0", "256,0"]);
    expect([...store.tiles.keys()]).toEqual(["0,0"]);
    expect([...q.masks.keys()].sort()).toEqual(["0,0", "256,0"]);
    stroke([100]);
    await q.idle();
    expect([...q.masks.keys()]).toEqual(["0,0"]);
  });

  it("queues cells during a held read, applies them in order once reads resume, and is busy until then", async () => {
    const src = instrumented();
    const { q, store, events } = queue(src);
    src.hold();
    q.push({ w: dab(store, 10, 10), value: 1, erase: false });
    q.push({ w: dab(store, 12, 10), value: 2, erase: false });
    q.push({ w: dab(store, 12, 10, 1), value: 2, erase: true }); // erase waits its turn too
    await new Promise((r) => setTimeout(r, 20));
    expect(store.tiles.size).toBe(0);
    expect(q.size).toBe(3);
    expect(events.busy).toEqual([true]);
    src.release();
    await q.idle();
    const t = store.tiles.get("0,0")!;
    expect([t[10 * 256 + 8], t[10 * 256 + 9], t[10 * 256 + 12], t[10 * 256 + 15], t[10 * 256 + 16]]).toEqual([1, 2, 0, 2, 0]);
    expect(events.busy).toEqual([true, false]);
    expect(events.applied).toBe(3);
    expect(src.reads).toHaveLength(1);
  });

  it("clear drops the queue and every mask, and a read finishing afterwards changes nothing", async () => {
    const src = instrumented();
    const { q, store } = queue(src);
    q.push({ w: dab(store, 10, 10), value: 1, erase: false });
    await q.idle();
    src.hold();
    q.push({ w: dab(store, 600, 10), value: 1, erase: false });
    await new Promise((r) => setTimeout(r, 10));
    q.clear();
    expect(q.size).toBe(0);
    expect(q.masks.size).toBe(0);
    src.release();
    await new Promise((r) => setTimeout(r, 10));
    expect([...store.tiles.keys()]).toEqual(["0,0"]);
    expect(q.masks.size).toBe(0);
  });

  it("reports full, changes nothing for that cell and applies the next", async () => {
    const { source } = fakeSource({ width: 4096, height: 8192 }, () => 5);
    const store = emptyStore(4096, 8192);
    for (let i = 0; i < 256; i++) store.tiles.set(`${(i % 16) * 256},${Math.floor(i / 16) * 256}`, new Uint8Array(65536).fill(1));
    let full = 0;
    const q = new PaintQueue(source, () => store, { applied() {}, full: () => { full++; }, busy() {}, error: (e) => { throw e; } });
    q.push({ w: dab(store, 100, 16 * 256 + 100), value: 2, erase: false });
    q.push({ w: dab(store, 100, 100), value: 2, erase: false });
    await q.idle();
    expect(full).toBe(1);
    expect(store.tiles.size).toBe(256);
    expect(store.tiles.get("0,0")![100 * 256 + 100]).toBe(2);
  });
});

describe("errors", () => {
  // value 0 makes brush throw after the cell left the queue, so the queue is already empty when it fails
  for (const erase of [true, false]) {
    it(`reports idle when brush throws on the last ${erase ? "erase" : "paint"} cell`, async () => {
      const src = instrumented();
      const store = emptyStore(2048, 2048);
      const busy: boolean[] = [], errors: unknown[] = [];
      const q = new PaintQueue(src.source, () => store, { applied() {}, full() {}, busy: (b) => { busy.push(b); }, error: (e) => { errors.push(e); } });
      q.push({ w: dab(store, 10, 10), value: 0, erase });
      await new Promise((r) => setTimeout(r, 20));
      expect(errors).toHaveLength(1);
      expect(q.size).toBe(0);
      expect(busy).toEqual([true, false]);
      q.push({ w: dab(store, 10, 10), value: 1, erase: false }); // the queue still works
      await new Promise((r) => setTimeout(r, 20));
      expect(busy).toEqual([true, false, true, false]);
      expect(store.tiles.size).toBe(1);
    });
  }
});
