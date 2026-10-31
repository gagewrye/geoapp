import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelClass } from "../../../src/core/classes";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { rasterKey } from "../../../src/core/session";
import type { Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import type { MaskBase } from "../../../src/io/maskBase";
import type { SessionRecord } from "../../../src/io/session";
import { MESSAGES } from "../../../src/ui/messages";
import { initPersist, MAX_SESSIONS, RETRY_MS, SAVE_DELAY_MS, type PersistLabels } from "../../../src/ui/persist";
import { fakeSessionStore } from "../helpers/sessionStore";

// Spec 031 criteria 2-5, with the fake store and fake timers.
const G: Grid = { width: 1000, height: 700, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] };
const SIZE = 4321, KEY = rasterKey(SIZE, G);
const tile = (v: number) => new Uint8Array(256 * 256).fill(v);

function setup(opts: { confirm?: boolean } = {}) {
  const fake = fakeSessionStore();
  let store: LabelStore = emptyStore(G.width, G.height);
  let classes: LabelClass[] = [{ name: "Class 1", colour: "#1f77b4" }, { name: "Class 2", colour: "#ff7f0e" }];
  let selected = 0, view = { opacity: 0.6, visible: true }, base: MaskBase | null = null;
  const flags = { stroking: false };
  const restored: unknown[] = [];
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => selected, view: () => view, base: () => base,
    stroking: () => flags.stroking, hasLabels: () => store.tiles.size > 0 || (base?.count ?? 0) > 0,
    restoreSession(s, c, b, sel, v) { store = s; classes = c; base = b; selected = sel; view = v; restored.push({ s, c, b, sel, v }); },
  };
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const state = { textContent: "" as string | null };
  const prompts: string[] = [];
  const p = initPersist({
    labels, open: async () => fake.store, state, win, doc, yieldTask: async () => {}, now: () => Date.now(),
    confirm: (t) => { prompts.push(t); return opts.confirm ?? true; },
    openBase: async (blob) => ({ meta: { width: G.width, height: G.height }, blob } as unknown as LabelSource),
    time: () => "12:00", dateTime: () => "30/10/2026, 12:00",
  });
  /** A beforeunload event's outcome: true when the guard cancelled it. */
  const guarded = () => { const e = new Event("beforeunload", { cancelable: true }); win.dispatchEvent(e); return e.defaultPrevented; };
  const paint = (key: string, v: number) => { store.tiles.set(key, tile(v)); p.tiles([key]); };
  const ready = async () => { p.open("a.tif", SIZE, G); await p.offer(); };
  return { fake, p, flags, win, doc, state, prompts, restored, guarded, paint, ready, set: {
    store: (s: LabelStore) => { store = s; }, base: (b: MaskBase | null) => { base = b; }, classes: (c: LabelClass[]) => { classes = c; },
  }, get: () => ({ store, classes, selected, view, base }) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("debounced saves (criterion 2)", () => {
  it("writes a painted tile 2 s after the stroke ends, not before and not during it", async () => {
    const t = setup();
    await t.ready();
    t.flags.stroking = true;
    t.paint("0,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 500); // still stroking: the timer finds a stroke and waits
    t.paint("256,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 500);
    expect(t.fake.log).toEqual([]);
    t.flags.stroking = false;
    t.p.strokeEnded();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
    expect(t.fake.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await t.p.idle();
    expect(t.fake.log).toEqual(["putTiles 2", "putRecord"]);
    expect([...t.fake.tiles.get(KEY)!.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(new Uint8Array(t.fake.tiles.get(KEY)!.get("0,0")!)).toEqual(tile(1));
    expect(t.state.textContent).toBe("Saved 12:00");
  });

  it("copies tiles when saved: a later edit in place isn't in that save", async () => {
    const t = setup();
    await t.ready();
    t.paint("0,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    t.get().store.tiles.get("0,0")!.fill(2); // before the write runs
    await t.p.idle();
    expect(new Uint8Array(t.fake.tiles.get(KEY)!.get("0,0")!)[0]).toBe(1);
  });

  it("undoing a tile back to no tile deletes the saved tile", async () => {
    const t = setup();
    await t.ready();
    t.paint("0,0", 1); t.paint("256,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    t.get().store.tiles.delete("0,0");
    t.p.tiles(["0,0"]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect([...t.fake.tiles.get(KEY)!.keys()]).toEqual(["256,0"]);
  });

  it("no transaction carries more than 16 tiles", async () => {
    const t = setup();
    await t.ready();
    for (let i = 0; i < 40; i++) t.get().store.tiles.set(`${(i % 4) * 256},${Math.floor(i / 4) * 256}`, tile(1));
    t.p.tiles(t.get().store.tiles.keys());
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.log).toEqual(["putTiles 16", "putTiles 16", "putTiles 8", "putRecord"]);
  });

  it("a record edit alone with no labels saves nothing", async () => {
    const t = setup();
    await t.ready();
    t.p.record();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.log).toEqual([]);
    expect(t.state.textContent).toBe("");
    expect(t.guarded()).toBe(false);
  });
});

describe("hidden and closing tabs (criterion 3)", () => {
  it("a visibilitychange to hidden starts a save without waiting for the debounce, and so does pagehide", async () => {
    const t = setup();
    await t.ready();
    t.paint("0,0", 1);
    t.doc.visibilityState = "hidden";
    t.doc.dispatchEvent(new Event("visibilitychange"));
    await t.p.idle();
    expect(t.fake.log).toEqual(["putTiles 1", "putRecord"]);
    t.paint("256,0", 1);
    t.win.dispatchEvent(new Event("pagehide"));
    await t.p.idle();
    expect(t.fake.log).toEqual(["putTiles 1", "putRecord", "putTiles 1", "putRecord"]);
  });
});

describe("the unsaved guard (criterion 4)", () => {
  it("is attached iff something is dirty, a save is in flight, or the last save failed; a successful save removes it", async () => {
    const t = setup();
    await t.ready();
    expect(t.guarded()).toBe(false);
    t.paint("0,0", 1);
    expect(t.guarded()).toBe(true); // dirty
    let release!: () => void;
    const put = t.fake.store.putRecord.bind(t.fake.store);
    t.fake.store.putRecord = async (r: SessionRecord) => { await new Promise<void>((res) => { release = res; }); return put(r); };
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(t.state.textContent).toBe("Saving…");
    expect(t.guarded()).toBe(true); // in flight, nothing dirty
    release();
    await t.p.idle();
    expect(t.guarded()).toBe(false);
    t.fake.store.putRecord = put;
    t.fake.failWith(new DOMException("full", "QuotaExceededError"));
    t.paint("256,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.state.textContent).toBe("Not saved: the browser's storage is full");
    expect(t.guarded()).toBe(true); // failed (and dirty again)
    t.fake.failWith(null);
    await vi.advanceTimersByTimeAsync(RETRY_MS); await t.p.idle(); // spec 032: a failed save is retried after RETRY_MS
    expect(t.guarded()).toBe(false);
    expect([...t.fake.tiles.get(KEY)!.keys()].sort()).toEqual(["0,0", "256,0"]);
  });
});

describe("replace, Cancel and eviction (criterion 5)", () => {
  it("a replace clears the old tiles before the new ones are written, and copies the mask file once", async () => {
    const t = setup();
    await t.ready();
    t.paint("0,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    t.fake.log.length = 0;
    const next = emptyStore(G.width, G.height);
    next.tiles.set("512,256", tile(3));
    t.set.store(next);
    t.p.replaced();
    t.p.imported(new Blob(["mask"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.log).toEqual(["clearTiles", "saveBase", "putTiles 1", "putRecord"]);
    expect([...t.fake.tiles.get(KEY)!.keys()]).toEqual(["512,256"]);
    t.paint("512,256", 4);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.log.filter((x) => x === "saveBase")).toHaveLength(1);
  });

  it("Cancel on the restore prompt deletes the session; OK restores tiles, classes, selection, view and the mask", async () => {
    const a = setup();
    await a.ready();
    a.paint("0,0", 1); a.paint("256,256", 2);
    a.set.classes([{ name: "Mangrove", colour: "#123456" }, { name: "Water", colour: "#654321" }]);
    a.set.base({ lut: new Uint8Array([0, 1]), count: 5, windows: new Set(["0,0"]), preview: { values: new Uint8Array([1, 2]) } } as unknown as MaskBase);
    a.p.imported(new Blob(["mask"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await a.p.idle();

    // a reload: a new page with the same store
    const b = setup();
    for (const [k, v] of a.fake.records) b.fake.records.set(k, v);
    for (const [k, v] of a.fake.tiles) b.fake.tiles.set(k, v);
    for (const [k, v] of a.fake.bases) b.fake.bases.set(k, v);
    b.p.open("renamed.tif", SIZE, G);
    expect(await b.p.offer()).toBe(MESSAGES.restored);
    expect(b.prompts).toEqual([MESSAGES.restore("30/10/2026, 12:00", "a.tif")]);
    const got = b.get();
    expect([...got.store.tiles.keys()].sort()).toEqual(["0,0", "256,256"]);
    expect(got.store.tiles.get("256,256")).toEqual(tile(2));
    expect(got.classes.map((c) => c.name)).toEqual(["Mangrove", "Water"]);
    expect(got.base!.count).toBe(5);
    expect([...got.base!.windows]).toEqual(["0,0"]);
    expect(got.base!.preview.corners).toHaveLength(4);
    expect(b.fake.log).toEqual([]); // a restore saves nothing back

    const c = setup({ confirm: false });
    for (const [k, v] of a.fake.records) c.fake.records.set(k, v);
    for (const [k, v] of a.fake.tiles) c.fake.tiles.set(k, v);
    c.p.open("a.tif", SIZE, G);
    expect(await c.p.offer()).toBe(null);
    expect(c.fake.log).toEqual([`delete ${KEY}`]);
    expect(c.fake.records.size).toBe(0);
  });

  it("a missing mask copy restores the tiles alone and asks for the mask again", async () => {
    const t = setup();
    t.fake.records.set(KEY, { key: KEY, name: "a.tif", savedAt: 1, classes: [{ name: "A", colour: "#000000" }], selected: 0, opacity: 0.3, visible: true,
      base: { lut: new Uint8Array(2), count: 3, windows: ["0,0"], values: new Uint8Array(1) } });
    t.fake.tiles.set(KEY, new Map([["0,0", tile(1).buffer]]));
    t.p.open("a.tif", SIZE, G);
    expect(await t.p.offer()).toBe(MESSAGES.restoredNoMask);
    expect(t.get().base).toBe(null);
    expect(t.get().view.opacity).toBe(0.3);
    expect(t.get().store.tiles.size).toBe(1);
  });

  it("a ninth session evicts the least recently saved one and its mask copy", async () => {
    const t = setup();
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const key = `old${i}`;
      t.fake.records.set(key, { key, name: key, savedAt: 100 + (i === 3 ? -50 : i), classes: [], selected: 0, opacity: 0.6, visible: true, base: null });
      t.fake.bases.set(key, new Blob([key]));
    }
    await t.ready();
    t.paint("0,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.log.at(-1)).toBe("delete old3");
    expect(t.fake.records.size).toBe(MAX_SESSIONS);
    expect(t.fake.bases.has("old3")).toBe(false);
    expect(t.fake.records.has(KEY)).toBe(true);
  });

  it("opening another raster saves the first one's changes at once, and the new one saves nothing until its offer is answered", async () => {
    const t = setup();
    await t.ready();
    t.paint("0,0", 1);
    t.p.open("b.tif", SIZE + 1, G);
    await t.p.idle();
    expect(t.fake.records.has(KEY)).toBe(true);
    t.fake.log.length = 0;
    t.paint("256,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.log).toEqual([]);
    expect(await t.p.offer()).toBe(null);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.log).toEqual(["putTiles 1", "putRecord"]);
  });
});
