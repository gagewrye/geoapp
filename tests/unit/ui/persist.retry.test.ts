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

function setup() {
  const fake = fakeSessionStore();
  let store: LabelStore = emptyStore(G.width, G.height);
  const classes: LabelClass[] = [{ name: "Class 1", colour: "#1f77b4" }];
  const prompts: string[] = [], answers: boolean[] = [];
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => null,
    stroking: () => false, hasLabels: () => store.tiles.size > 0, restoreSession(s) { store = s; },
  };
  const classes2 = new Set<string>();
  const state = { textContent: "" as string | null, classList: { toggle: (c: string, on: boolean) => { if (on) classes2.add(c); else classes2.delete(c); } } };
  const p = initPersist({ labels, open: async () => fake.store, state, win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    yieldTask: async () => {}, time: () => "12:00", confirm: (t) => { prompts.push(t); return answers.shift() ?? true; } });
  // saveBase counted, failing with quota while `full`
  const copy = { calls: 0, full: true };
  const saveBase = fake.store.saveBase.bind(fake.store);
  fake.store.saveBase = async (k, f) => { copy.calls++; if (copy.full) throw QUOTA(); return saveBase(k, f); };
  const paint = (k: string, v: number) => { store.tiles.set(k, tile(v)); p.tiles([k]); };
  return { fake, p, prompts, answers, state, stateClasses: classes2, copy, paint, emptyStore: () => { store = emptyStore(G.width, G.height); } };
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
