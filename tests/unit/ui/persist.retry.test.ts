import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelClass } from "../../../src/core/classes";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { MESSAGES } from "../../../src/ui/messages";
import { initPersist, RETRY_MS, SAVE_DELAY_MS, type PersistLabels } from "../../../src/ui/persist";
import { fakeSessionStore } from "../helpers/sessionStore";

// Spec 032 criteria 7 (save retries, quota skips the mask copy) and 8 (the discard question).
const G: Grid = { width: 1000, height: 700, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] };
const tile = (v: number) => new Uint8Array(256 * 256).fill(v);
const QUOTA = () => new DOMException("full", "QuotaExceededError");

function setup(fake = fakeSessionStore()) {
  let store: LabelStore = emptyStore(G.width, G.height);
  let base: unknown = null;
  const opens: Blob[] = [];
  const classes: LabelClass[] = [{ name: "Class 1", colour: "#1f77b4" }];
  const prompts: string[] = [], answers: boolean[] = [];
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => base as never,
    stroking: () => false, hasLabels: () => store.tiles.size > 0 || base !== null, restoreSession(s) { store = s; },
  };
  const classes2 = new Set<string>();
  const state = { textContent: "" as string | null, classList: { toggle: (c: string, on: boolean) => { if (on) classes2.add(c); else classes2.delete(c); } } };
  const p = initPersist({ labels, open: async () => fake.store, state, win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    yieldTask: async () => {}, time: () => "12:00", openBase: async (blob) => { opens.push(blob); throw new Error("opened a copy"); }, confirm: (t) => { prompts.push(t); return answers.shift() ?? true; } });
  // saveBase counted, failing with quota while `full`
  const copy = { calls: 0, full: true };
  const saveBase = fake.store.saveBase.bind(fake.store);
  fake.store.saveBase = async (k, f) => { copy.calls++; if (copy.full) throw QUOTA(); return saveBase(k, f); };
  const paint = (k: string, v: number) => { store.tiles.set(k, tile(v)); p.tiles([k]); };
  return { fake, p, prompts, answers, state, stateClasses: classes2, copy, paint, emptyStore: () => { store = emptyStore(G.width, G.height); }, setBase: (b: unknown) => { base = b; }, store: () => store, opens };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("save retries (criterion 7)", () => {
  it("after a quota error the next try is at 30 s, not 2 s, and writes tiles and the record without the mask copy", async () => {
    const t = setup();
    t.p.open("a.tif", 1, G); await t.p.offer();
    t.paint("0,0", 1);
    t.p.imported(new Blob(["mask"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.copy.calls).toBe(1);
    expect(t.state.textContent).toBe("Not saved: the browser's storage is full");
    expect(t.stateClasses.has("error")).toBe(true);
    t.fake.log.length = 0;
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2); await t.p.idle();
    expect(t.fake.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_MS - SAVE_DELAY_MS * 2); await t.p.idle(); // 30 s after the failure
    expect(t.fake.log).toEqual(["putTiles 1", "putRecord"]);
    expect(t.copy.calls).toBe(1);
    expect(t.state.textContent).toBe("Saved 12:00");
    expect(t.stateClasses.has("error")).toBe(false);
  });

  it("over 5 minutes of failures the copy is tried at most once, and a new import tries it again; new changes still save at 2 s", async () => {
    const t = setup();
    t.p.open("a.tif", 1, G); await t.p.offer();
    t.fake.failWith(QUOTA());
    t.paint("0,0", 1);
    t.p.imported(new Blob(["mask"]));
    for (let ms = 0; ms < 5 * 60_000; ms += 1000) await vi.advanceTimersByTimeAsync(1000);
    await t.p.idle();
    expect(t.copy.calls).toBe(1);
    t.fake.failWith(null);
    t.paint("256,0", 2); // a new change: the 2 s delay, not the retry's
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.fake.records.size).toBe(1);
    expect(t.copy.calls).toBe(1);
    t.copy.full = false;
    t.p.imported(new Blob(["mask 2"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.copy.calls).toBe(2);
    expect(t.fake.bases.size).toBe(1);
  });
});

describe("a record saved without its import's copy (criterion 7)", () => {
  it("import A copied, then import B whose copy fails on quota: a restore brings back B's tiles, never opens A's copy, and asks for the mask", async () => {
    const t = setup();
    t.copy.full = false;
    t.p.open("a.tif", 1, G); await t.p.offer();
    const base = (count: number) => ({ lut: new Uint8Array(4), count, windows: new Set(["0,0"]), preview: { values: new Uint8Array(4) } });
    t.setBase(base(5));
    t.p.replaced(); t.p.imported(new Blob(["mask A"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    expect(t.copy.calls).toBe(1);
    // import B: its own tiles, its copy refused
    t.copy.full = true;
    t.emptyStore();
    t.paint("512,256", 3);
    t.setBase(base(9));
    t.p.replaced(); t.p.imported(new Blob(["mask B"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await t.p.idle();
    await vi.advanceTimersByTimeAsync(RETRY_MS); await t.p.idle();
    const r = [...t.fake.records.values()][0]!;
    expect(r.base!.count).toBe(9);
    expect(r.base!.copyMissing).toBe(true);
    expect(t.fake.bases.size).toBe(0); // the stale copy of A is deleted when space allows

    const b = setup(t.fake);
    b.p.open("a.tif", 1, G);
    t.fake.bases.set(r.key, new Blob(["mask A"])); // even with A's copy still there
    expect(await b.p.offer()).toBe(MESSAGES.restoredNoMask);
    expect(b.opens).toEqual([]);
    expect([...b.store().tiles.keys()]).toEqual(["512,256"]);
  });
});

describe("a copy still being written isn't missing (spec 032 review)", () => {
  it("a save taken while the first save streams the copy doesn't mark it missing or delete it, and a restore opens the copy", async () => {
    const t = setup();
    t.copy.full = false;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const saveBase = t.fake.store.saveBase;
    t.fake.store.saveBase = async (k, f) => { await held; return saveBase(k, f); };
    t.p.open("a.tif", 1, G); await t.p.offer();
    t.setBase({ lut: new Uint8Array(4), count: 5, windows: new Set(["0,0"]), preview: { values: new Uint8Array(4) } });
    t.p.replaced(); t.p.imported(new Blob(["mask"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); // save 1 streams the copy
    t.paint("0,0", 1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); // save 2 is taken meanwhile
    release();
    await t.p.idle();
    expect(t.fake.log).not.toContain("deleteBase");
    const key = [...t.fake.records.keys()][0]!;
    expect(t.fake.records.get(key)!.base!.copyMissing).toBeUndefined();
    expect(t.fake.bases.has(key)).toBe(true);

    const b = setup(t.fake);
    b.p.open("a.tif", 1, G);
    await b.p.offer();
    expect(b.opens).toHaveLength(1); // it opened the copy (this fake's openBase then fails)
  });
});

describe("the discard question (criterion 8)", () => {
  it("with labels and nothing pending, opening another raster asks the scope 6 text; Cancel stops the open", async () => {
    const t = setup();
    t.p.open("a.tif", 1, G); await t.p.offer();
    t.paint("0,0", 1);
    t.answers.push(false);
    expect(t.p.open("b.tif", 2, G, true)).toBe(false);
    expect(t.prompts).toEqual([MESSAGES.discard]);
    expect(MESSAGES.discard).toBe("Close these labels? They stay saved in this browser.");
    expect(t.p.open("b.tif", 2, G, true)).toBe(true);
    expect(t.p.open("c.tif", 3, G, false)).toBe(true); // no labels: no question
    expect(t.prompts).toHaveLength(2);
  });

  it("with a snapshot pending it asks spec 031's question instead", async () => {
    const t = setup();
    t.p.open("a.tif", 1, G); await t.p.offer();
    t.paint("0,0", 1);
    t.fake.failWith(QUOTA());
    t.p.open("b.tif", 2, G, true);
    t.emptyStore();
    await t.p.idle(); await t.p.offer();
    t.paint("0,0", 2);
    t.prompts.length = 0;
    t.answers.push(false);
    expect(t.p.open("c.tif", 3, G, true)).toBe(false);
    expect(t.prompts).toEqual([MESSAGES.pendingDiscard("a.tif", "the browser's storage is full")]);
  });
});
