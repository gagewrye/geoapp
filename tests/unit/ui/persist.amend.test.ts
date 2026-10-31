import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelClass } from "../../../src/core/classes";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { rasterKey } from "../../../src/core/session";
import type { Grid } from "../../../src/core/types";
import type { SessionRecord } from "../../../src/io/session";
import { MESSAGES } from "../../../src/ui/messages";
import { initPersist, RETRY_MS, SAVE_DELAY_MS, type PersistLabels } from "../../../src/ui/persist";
import { controlsDisabled } from "../../../src/ui/seeding";
import { fakeSessionStore } from "../helpers/sessionStore";

// Spec 031 as amended: criteria 11 (the restore lock), 12 and 13 (a pending snapshot).
const G: Grid = { width: 1000, height: 700, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] };
const KEY = (size: number) => rasterKey(size, G);
const tile = (v: number) => new Uint8Array(256 * 256).fill(v);
const QUOTA = () => new DOMException("full", "QuotaExceededError");

/** A promise with its resolve and reject. */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function setup() {
  const fake = fakeSessionStore();
  let store: LabelStore = emptyStore(G.width, G.height);
  const classes: LabelClass[] = [{ name: "Class 1", colour: "#1f77b4" }];
  const lock = { on: false, log: [] as boolean[] };
  const answers: boolean[] = [];
  const prompts: string[] = [];
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => null,
    stroking: () => false, hasLabels: () => store.tiles.size > 0,
    restoreSession(s) { store = s; },
    restoreLock(on) { lock.on = on; lock.log.push(on); },
  };
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const state = { textContent: "" as string | null };
  const p = initPersist({ labels, open: async () => fake.store, state, win, doc, yieldTask: async () => {}, time: () => "12:00", dateTime: () => "d",
    confirm: (t) => { prompts.push(t); return answers.shift() ?? true; } });
  const guarded = () => { const e = new Event("beforeunload", { cancelable: true }); win.dispatchEvent(e); return e.defaultPrevented; };
  /** A stroke: applies only while the labels aren't locked (spec 004's lock stops the brush). */
  const paint = (key: string, v: number) => { if (lock.on) return; store.tiles.set(key, tile(v)); p.tiles([key]); };
  const flush = async (ms = SAVE_DELAY_MS) => { await vi.advanceTimersByTimeAsync(ms); await p.idle(); };
  /** Opens a raster as main does: the labels switch to an empty store after persist.open says yes. */
  const open = (name: string, size: number) => { const ok = p.open(name, size, G); if (ok) store = emptyStore(G.width, G.height); return ok; };
  const record = (size: number): SessionRecord => ({ key: KEY(size), name: "a.tif", savedAt: 1, classes, selected: 0, opacity: 0.6, visible: true, base: null });
  return { fake, p, lock, answers, prompts, state, guarded, paint, flush, open, record, store: () => store };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the restore lock (criterion 11)", () => {
  it("with a session: locked from the offer through the prompt until the restore finishes; strokes change nothing meanwhile", async () => {
    const t = setup();
    t.fake.records.set(KEY(1), t.record(1));
    t.fake.tiles.set(KEY(1), new Map([["0,0", tile(3).buffer]]));
    const get = deferred<SessionRecord | null>(), tiles = deferred<[string, ArrayBuffer][]>();
    const realGet = t.fake.store.get.bind(t.fake.store), realTiles = t.fake.store.tiles.bind(t.fake.store);
    t.fake.store.get = async (k) => { await get.promise; return realGet(k); };
    t.fake.store.tiles = async (...a) => { await tiles.promise; return realTiles(...a); };
    t.open("a.tif", 1);
    const offered = t.p.offer(); // "Raster opened."
    await vi.advanceTimersByTimeAsync(0);
    expect(t.lock.on).toBe(true);
    t.paint("256,0", 9);
    get.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.prompts).toHaveLength(1);
    expect(t.lock.on).toBe(true); // tiles still loading
    t.paint("256,0", 9);
    tiles.resolve([]);
    expect(await offered).toBe(MESSAGES.restored);
    expect(t.lock.on).toBe(false);
    expect([...t.store().tiles.keys()]).toEqual(["0,0"]);
  });

  it("unlocks after Cancel, and after a restore that fails", async () => {
    const a = setup();
    a.fake.records.set(KEY(1), a.record(1));
    a.answers.push(false);
    a.open("a.tif", 1);
    expect(await a.p.offer()).toBe(null);
    expect(a.lock.log).toEqual([true, false]);

    const b = setup();
    b.fake.records.set(KEY(1), b.record(1));
    b.fake.store.tiles = async () => { throw new Error("unreadable"); };
    b.open("a.tif", 1);
    await expect(b.p.offer()).rejects.toThrow("unreadable");
    expect(b.lock.log).toEqual([true, false]);
    b.paint("0,0", 1);
    expect(b.store().tiles.size).toBe(1);
  });

  it("with no session: locked only until get settles, and not at all when it settled before the offer; a failed get counts as none", async () => {
    const a = setup();
    const get = deferred<null>();
    a.fake.store.get = () => get.promise;
    a.open("a.tif", 1);
    const offered = a.p.offer();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.lock.on).toBe(true);
    get.resolve(null);
    expect(await offered).toBe(null);
    expect(a.lock.log).toEqual([true, false]);

    const b = setup();
    b.open("a.tif", 1);
    await vi.advanceTimersByTimeAsync(0); // the lookup, started at open, settles before "Raster opened."
    expect(await b.p.offer()).toBe(null);
    expect(b.lock.log).toEqual([]);

    const c = setup();
    c.fake.store.get = async () => { throw new Error("no IndexedDB"); };
    c.open("a.tif", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(await c.p.offer()).toBe(null);
    expect(c.lock.log).toEqual([]);
  });

  it("Import labels and Export labels are disabled while the labels are locked", () => {
    const free = { imagery: true, seeding: false, queued: false, exporting: false, locked: false };
    expect(controlsDisabled(free)).toEqual({ importLabels: false, exportLabels: false });
    expect(controlsDisabled({ ...free, locked: true })).toEqual({ importLabels: true, exportLabels: true });
    expect(controlsDisabled({ ...free, exporting: true })).toEqual({ importLabels: false, exportLabels: true });
    expect(controlsDisabled({ ...free, imagery: false })).toEqual({ importLabels: true, exportLabels: true });
  });
});

/** A open and painted, then B opened while writes fail: A's snapshot is pending. */
async function pendingA() {
  const t = setup();
  t.open("a.tif", 1); await t.p.offer();
  t.paint("0,0", 1); t.paint("256,0", 2);
  const aTiles = t.store();
  t.fake.failWith(QUOTA());
  expect(t.open("b.tif", 2)).toBe(true);
  aTiles.tiles.get("0,0")!.fill(7); // A's store after B opened: not what A saves
  await t.p.idle();
  await t.p.offer();
  return t;
}

describe("a pending snapshot (criterion 12)", () => {
  it("B's saves show A's failure, never Saved, and keep the guard on; once writes succeed A is written before B", async () => {
    const t = await pendingA();
    const pendingText = "Not saved: a.tif: the browser's storage is full";
    expect(t.state.textContent).toBe(pendingText);
    expect(t.guarded()).toBe(true);
    t.paint("512,0", 3);
    await t.flush();
    expect(t.state.textContent).toBe(pendingText);
    expect(t.guarded()).toBe(true);
    t.fake.failWith(null);
    t.fake.log.length = 0;
    t.paint("512,256", 4);
    await t.flush();
    expect(t.fake.log).toEqual(["putTiles 2", "putRecord", "putTiles 2", "putRecord"]);
    expect([...t.fake.tiles.get(KEY(1))!.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(new Uint8Array(t.fake.tiles.get(KEY(1))!.get("0,0")!)[0]).toBe(1);
    expect(t.fake.records.get(KEY(1))!.name).toBe("a.tif");
    expect([...t.fake.tiles.get(KEY(2))!.keys()].sort()).toEqual(["512,0", "512,256"]);
    expect(t.state.textContent).toBe("Saved 12:00");
    expect(t.guarded()).toBe(false);
  });

  it("a retry runs every 30 s while a snapshot is pending", async () => {
    const t = await pendingA();
    await t.flush(RETRY_MS); // still failing
    expect(t.fake.records.has(KEY(1))).toBe(false);
    t.fake.failWith(null);
    await t.flush(RETRY_MS);
    expect([...t.fake.tiles.get(KEY(1))!.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(t.fake.records.has(KEY(1))).toBe(true);
    expect(t.guarded()).toBe(false);
    expect(t.state.textContent).toBe("Saved 12:00");
  });
});

describe("opening another raster while a snapshot is pending (criterion 13)", () => {
  it("asks first: Cancel keeps B open and the snapshot pending; OK drops it, opens C, and #save-state reflects C alone", async () => {
    const t = await pendingA();
    t.answers.push(false);
    expect(t.open("c.tif", 3)).toBe(false);
    expect(t.prompts.at(-1)).toBe(MESSAGES.pendingDiscard("a.tif", "the browser's storage is full"));
    expect(t.guarded()).toBe(true);
    expect(t.state.textContent).toBe("Not saved: a.tif: the browser's storage is full");
    t.answers.push(true);
    expect(t.open("c.tif", 3)).toBe(true);
    expect(t.state.textContent).toBe("");
    expect(t.guarded()).toBe(false);
    t.fake.failWith(null);
    await t.p.offer();
    t.paint("0,0", 5);
    await t.flush();
    expect(t.fake.records.has(KEY(1))).toBe(false);
    expect(t.fake.records.has(KEY(3))).toBe(true);
    expect(t.state.textContent).toBe("Saved 12:00");
  });
});
