import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelClass } from "../../../src/core/classes";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { rasterKey } from "../../../src/core/session";
import type { Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import type { MaskBase } from "../../../src/io/maskBase";
import { initPersist, RETRY_MS, SAVE_DELAY_MS, TILE_BATCH, type PersistLabels } from "../../../src/ui/persist";
import { fakeSessionStore } from "../helpers/sessionStore";

// Tester, spec 031: strokes made before the restore prompt is answered, restores across batch boundaries,
// a failed mask copy, the order of a full replace's writes, and labels going to none.
const G: Grid = { width: 4096, height: 2048, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] };
const SIZE = 999, KEY = rasterKey(SIZE, G);
const tile = (v: number) => new Uint8Array(256 * 256).fill(v);
const keys = (n: number) => Array.from({ length: n }, (_, i) => `${(i % 16) * 256},${Math.floor(i / 16) * 256}`);

function setup(fake = fakeSessionStore(), confirmAnswer = true) {
  let store: LabelStore = emptyStore(G.width, G.height), base: MaskBase | null = null;
  const classes: LabelClass[] = [{ name: "Class 1", colour: "#1f77b4" }];
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => base,
    stroking: () => false, hasLabels: () => store.tiles.size > 0 || (base?.count ?? 0) > 0,
    restoreSession(s, _c, b) { store = s; base = b; },
  };
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const state = { textContent: "" as string | null };
  const p = initPersist({ labels, open: async () => fake.store, state, win, doc, yieldTask: async () => {}, confirm: () => confirmAnswer,
    openBase: async (blob) => ({ meta: { width: G.width, height: G.height }, blob } as unknown as LabelSource), time: () => "t", dateTime: () => "d" });
  const guarded = () => { const e = new Event("beforeunload", { cancelable: true }); win.dispatchEvent(e); return e.defaultPrevented; };
  const paint = (k: string, v: number) => { store.tiles.set(k, tile(v)); p.tiles([k]); };
  const erase = (k: string) => { store.tiles.delete(k); p.tiles([k]); };
  const flush = async () => { await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await p.idle(); };
  return { fake, p, state, guarded, paint, erase, flush, labels: () => ({ store, base }), setStore: (s: LabelStore) => { store = s; }, setBase: (b: MaskBase | null) => { base = b; } };
}
/** A saved session of n tiles of value 5 under KEY. */
async function saved(n: number) {
  const a = setup();
  a.p.open("a.tif", SIZE, G); await a.p.offer();
  for (const k of keys(n)) a.paint(k, 5);
  await a.flush();
  return a.fake;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("strokes made before the restore prompt is answered", () => {
  it("OK: the restore replaces them, and the next save leaves the store equal to the restored labels", async () => {
    const fake = await saved(3);
    const b = setup(fake);
    b.p.open("a.tif", SIZE, G);
    b.paint("3840,1792", 9); // painted between "Raster opened." and the prompt
    await b.flush();
    expect(fake.tiles.get(KEY)!.has("3840,1792")).toBe(false); // nothing saved over the session before the answer
    await b.p.offer();
    expect(b.labels().store.tiles.has("3840,1792")).toBe(false);
    b.paint("0,0", 7);
    await b.flush();
    expect([...fake.tiles.get(KEY)!.keys()].sort()).toEqual(keys(3).sort());
    expect(new Uint8Array(fake.tiles.get(KEY)!.get("0,0")!)[0]).toBe(7);
  });

  it("Cancel: they are kept, and saved once the session is deleted", async () => {
    const fake = await saved(3);
    const b = setup(fake, false);
    b.p.open("a.tif", SIZE, G);
    b.paint("3840,1792", 9);
    expect(b.guarded()).toBe(true);
    await b.p.offer();
    await b.flush();
    expect([...fake.tiles.get(KEY)!.keys()]).toEqual(["3840,1792"]);
    expect(b.guarded()).toBe(false);
  });
});

describe("restore", () => {
  for (const n of [TILE_BATCH, 2 * TILE_BATCH, 40]) {
    it(`restores all ${n} tiles across batches of ${TILE_BATCH}`, async () => {
      const fake = await saved(n);
      const b = setup(fake);
      let calls = 0;
      const tiles = fake.store.tiles.bind(fake.store);
      fake.store.tiles = async (k, after, m) => { calls++; expect(m).toBeLessThanOrEqual(TILE_BATCH); return tiles(k, after, m); };
      b.p.open("a.tif", SIZE, G);
      await b.p.offer();
      expect([...b.labels().store.tiles.keys()].sort()).toEqual(keys(n).sort());
      expect(calls).toBe(Math.floor(n / TILE_BATCH) + 1);
    });
  }
});

describe("writes", () => {
  it("a replace of 40 tiles with a mask: clearTiles, saveBase, batches of at most 16, the record last", async () => {
    const t = setup();
    t.p.open("a.tif", SIZE, G); await t.p.offer();
    const next = emptyStore(G.width, G.height);
    for (const k of keys(40)) next.tiles.set(k, tile(2));
    t.setStore(next);
    t.setBase({ lut: new Uint8Array(2), count: 9, windows: new Set(["0,0"]), preview: { values: new Uint8Array(4) } } as unknown as MaskBase);
    t.p.replaced(); t.p.imported(new Blob(["mask"]));
    await t.flush();
    expect(t.fake.log).toEqual(["clearTiles", "saveBase", "putTiles 16", "putTiles 16", "putTiles 8", "putRecord"]);
  });

  // spec 032 scope 5: a quota error leaves the copy out until the next import, so this failure is another write error
  it("a failed mask copy keeps the guard on and shows the reason; the retry copies the file again before the record", async () => {
    const t = setup();
    t.p.open("a.tif", SIZE, G); await t.p.offer();
    t.setBase({ lut: new Uint8Array(2), count: 9, windows: new Set(["0,0"]), preview: { values: new Uint8Array(4) } } as unknown as MaskBase);
    const save = t.fake.store.saveBase.bind(t.fake.store);
    let fail = true;
    t.fake.store.saveBase = async (k, f) => { if (fail) throw new Error("the disk failed"); return save(k, f); };
    t.p.replaced(); t.p.imported(new Blob(["mask"]));
    await t.flush();
    expect(t.state.textContent).toBe("Not saved: the disk failed");
    expect(t.guarded()).toBe(true);
    expect(t.fake.records.has(KEY)).toBe(false);
    fail = false;
    t.fake.log.length = 0;
    await vi.advanceTimersByTimeAsync(RETRY_MS); await t.p.idle(); // retried after RETRY_MS (spec 032)
    expect(t.fake.log).toEqual(["clearTiles", "saveBase", "putRecord"]);
    expect(t.fake.bases.has(KEY)).toBe(true);
    expect(t.guarded()).toBe(false);
  });

  it("erasing every tile deletes the saved session; a raster never saved with no labels writes nothing", async () => {
    const t = setup();
    t.p.open("a.tif", SIZE, G); await t.p.offer();
    t.paint("0,0", 1); t.paint("256,0", 1);
    await t.flush();
    t.erase("0,0"); t.erase("256,0");
    await t.flush();
    expect(t.fake.records.has(KEY)).toBe(false);
    expect(t.guarded()).toBe(false);
    t.fake.log.length = 0;
    t.paint("0,0", 1); t.erase("0,0");
    await t.flush();
    expect(t.fake.log).toEqual([]);
  });
});
