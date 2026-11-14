import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelClass } from "../../../src/core/classes";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { rasterKey } from "../../../src/core/session";
import type { Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import type { MaskBase } from "../../../src/io/maskBase";
import type { SessionRecord } from "../../../src/io/session";
import { MESSAGES } from "../../../src/ui/messages";
import { initPersist, SAVE_DELAY_MS, type PersistLabels } from "../../../src/ui/persist";
import { fakeSessionStore } from "../helpers/sessionStore";

// Spec 056 criteria 2-5 and scope 6, with the fake store and fake timers.
const G: Grid = { width: 1000, height: 700, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] };
const SIZE = 4321, KEY = rasterKey(SIZE, G);
const tile = (v: number) => new Uint8Array(256 * 256).fill(v);
const maskBase = (count: number) => ({ lut: new Uint8Array(4), count, windows: new Set(["0,0"]), preview: { values: new Uint8Array(4) } }) as unknown as MaskBase;

function setup(fake = fakeSessionStore(), answers: boolean[] = []) {
  let store: LabelStore = emptyStore(G.width, G.height), base: MaskBase | null = null;
  const classes: LabelClass[] = [{ name: "Class 1", colour: "#1f77b4" }];
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => base,
    stroking: () => false, hasLabels: () => store.tiles.size > 0 || (base?.count ?? 0) > 0,
    restoreSession(s, _c, b) { store = s; base = b; },
  };
  const prompts: string[] = [], said: [string, string | undefined][] = [];
  let clock = 1000;
  const p = initPersist({
    labels, open: async () => fake.store, state: { textContent: "" }, win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    yieldTask: async () => {}, now: () => clock, time: () => "12:00", dateTime: (ms) => `t${ms}`, say: (t, k) => { said.push([t, k]); },
    openBase: async (blob) => ({ meta: { width: G.width, height: G.height }, blob } as unknown as LabelSource),
    confirm: (t) => { prompts.push(t); return answers.shift() ?? true; },
  });
  const paint = (k: string, v: number) => { store.tiles.set(k, tile(v)); p.tiles([k]); };
  const flush = async (ms = SAVE_DELAY_MS) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); await p.idle(); };
  /** What seeding does for an import that succeeds: the refusal check, the flush, then the replace and the mask. */
  const importMask = async (count: number, key: string, v: number): Promise<string | null> => {
    const refused = labels.hasLabels() ? p.replaceRefused() : null;
    if (refused) return refused;
    p.flush(); await p.idle();
    store = emptyStore(G.width, G.height); store.tiles.set(key, tile(v)); base = maskBase(count);
    p.replaced(); p.imported(new Blob([`mask ${count}`]));
    return null;
  };
  const open = async () => { p.open("a.tif", SIZE, G); return p.offer(); };
  return { fake, p, prompts, said, paint, flush, importMask, open, store: () => store, base: () => base, tick: (ms: number) => { clock += ms; } };
}
const role = (f: ReturnType<typeof fakeSessionStore>, r: string) => [...f.records.values()].filter((x) => x.role === r);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A store with one saved current session of tiles 0,0 (value 1). */
async function saved() {
  const a = setup();
  await a.open();
  a.paint("0,0", 1);
  await a.flush();
  return a.fake;
}

describe("restore decline (criterion 2)", () => {
  it("Cancel, then Cancel restores the session; neither Cancel deletes", async () => {
    const fake = await saved();
    const b = setup(fake, [false, false]);
    expect(await b.open()).toBe(MESSAGES.restored);
    expect(b.prompts).toEqual([MESSAGES.restore("t3000", "a.tif"), MESSAGES.restoreDelete("t3000", "a.tif")]);
    expect([...b.store().tiles.keys()]).toEqual(["0,0"]);
    expect(fake.log.filter((x) => x.startsWith("delete"))).toEqual([]);
    expect(fake.records.has(KEY)).toBe(true);
  });

  it("Cancel, then OK deletes it", async () => {
    const fake = await saved();
    const b = setup(fake, [false, true]);
    expect(await b.open()).toBe(null);
    expect(fake.log.at(-1)).toBe(`delete ${KEY}`);
    expect(fake.records.size).toBe(0);
    expect(b.store().tiles.size).toBe(0);
  });
});

describe("replaced labels are kept (criterion 3)", () => {
  it("import A, paint, save, import B, save: A's tiles, record and copy are stored as replaced, B's as current", async () => {
    const t = setup();
    await t.open();
    expect(await t.importMask(5, "0,0", 1)).toBe(null);
    t.paint("256,0", 2);
    await t.flush();
    expect(await t.importMask(9, "512,256", 3)).toBe(null);
    await t.flush();
    const [a] = role(t.fake, "replaced"), [b] = role(t.fake, "current");
    expect(role(t.fake, "replaced")).toHaveLength(1);
    expect(role(t.fake, "current")).toHaveLength(1);
    expect(a!.base!.count).toBe(5);
    expect([...t.fake.tiles.get(a!.id)!.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(await t.fake.bases.get(a!.id)!.text()).toBe("mask 5");
    expect(b!.base!.count).toBe(9);
    expect([...t.fake.tiles.get(b!.id)!.keys()]).toEqual(["512,256"]);
    expect(await t.fake.bases.get(b!.id)!.text()).toBe("mask 9");
    expect(a!.raster).toBe(KEY);
    expect(b!.raster).toBe(KEY);
  });

  it("a third import, with A not exported, is refused with scope 2's message and changes nothing", async () => {
    const t = setup();
    await t.open();
    await t.importMask(5, "0,0", 1); await t.flush();
    await t.importMask(9, "512,256", 3); await t.flush();
    const before = structuredClone([...t.fake.records.values()]);
    expect(await t.importMask(7, "0,256", 4)).toBe(MESSAGES.replacedFirst);
    expect(MESSAGES.replacedFirst).toBe("Export or restore the earlier replaced labels first.");
    await t.flush();
    expect([...t.fake.records.values()]).toEqual(before);
    expect(t.base()!.count).toBe(9);
  });

  it("once A was exported after its last change, a third import drops A and keeps B as replaced", async () => {
    const t = setup();
    await t.open();
    await t.importMask(5, "0,0", 1); await t.flush();
    t.tick(10); t.p.exported(2000 + 10_000); // a verified export of A
    await t.flush();
    const a = role(t.fake, "current")[0]!;
    expect(a.exportedAt).toBeGreaterThanOrEqual(a.savedAt);
    await t.importMask(9, "512,256", 3); await t.flush();
    expect(await t.importMask(7, "0,256", 4)).toBe(null);
    await t.flush();
    expect(t.fake.records.has(a.id)).toBe(false);
    expect(t.fake.bases.has(a.id)).toBe(false);
    expect(role(t.fake, "replaced").map((r) => r.base!.count)).toEqual([9]);
    expect(role(t.fake, "current").map((r) => r.base!.count)).toEqual([7]);
  });

  it("on reopening, Cancel then OK on '…instead?' restores the replaced labels and swaps the roles; the newer are kept", async () => {
    const t = setup();
    await t.open();
    await t.importMask(5, "0,0", 1); await t.flush();
    await t.importMask(9, "512,256", 3); await t.flush();
    const aSaved = role(t.fake, "replaced")[0]!.savedAt;
    const b = setup(t.fake, [false, true]);
    expect(await b.open()).toBe(MESSAGES.restored);
    expect(b.prompts[1]).toBe(MESSAGES.restoreReplaced(`t${aSaved}`));
    expect(b.prompts[1]).toBe(`Restore the labels replaced on t${aSaved} instead? The newer labels are kept.`);
    expect(b.base()!.count).toBe(5);
    expect(role(t.fake, "current").map((r) => r.base!.count)).toEqual([5]);
    expect(role(t.fake, "replaced").map((r) => r.base!.count)).toEqual([9]);
    // the next reopening offers A as the current one
    const c = setup(t.fake);
    expect(await c.open()).toBe(MESSAGES.restored);
    expect(c.base()!.count).toBe(5);
  });

  it("with no current session, the replaced one gets the normal prompt and becomes current when restored", async () => {
    const fake = await saved();
    const r = fake.records.get(KEY)!;
    fake.records.set(KEY, { ...r, role: "replaced" });
    const b = setup(fake);
    expect(await b.open()).toBe(MESSAGES.restored);
    expect(b.prompts).toEqual([MESSAGES.restore(`t${r.savedAt}`, "a.tif")]);
    expect(fake.records.get(KEY)!.role).toBe("current");
  });
});

describe("a copy that keeps failing never blocks tiles (criterion 4)", () => {
  it("tiles and the record (copyMissing) are written on the first save; saveBase is called at most 4 times in 10 minutes; the message shows once", async () => {
    const t = setup();
    let calls = 0;
    t.fake.store.saveBase = async () => { calls++; throw new DOMException("The file changed.", "NotReadableError"); };
    await t.open();
    await t.importMask(5, "0,0", 1);
    t.paint("256,0", 2);
    await t.flush();
    const r = role(t.fake, "current")[0]!;
    expect([...t.fake.tiles.get(r.id)!.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(r.base!.copyMissing).toBe(true);
    for (let ms = 0; ms < 10 * 60_000; ms += 5000) await t.flush(5000);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(4);
    expect(t.said).toEqual([[MESSAGES.notSaving("The file changed."), "error"]]);
    expect(MESSAGES.notSaving("x")).toBe("Labels aren't being saved (x). Export them to keep a copy.");
  });

  it("the message shows again on a failure after a successful save", async () => {
    const t = setup();
    await t.open();
    t.fake.failWith(new Error("disk"));
    t.paint("0,0", 1); await t.flush();
    t.paint("256,0", 1); await t.flush(); // still failing: not said again
    t.fake.failWith(null);
    await t.flush(30_000);
    t.fake.failWith(new Error("disk 2"));
    t.paint("512,0", 1); await t.flush();
    expect(t.said.map(([s]) => s)).toEqual([MESSAGES.notSaving("disk"), MESSAGES.notSaving("disk 2")]);
  });
});

describe("spec 031 records (criterion 5)", () => {
  it("a record keyed by rasterKey, without id, raster, role or exportedAt, restores byte-equal tiles and its copy", async () => {
    const fake = fakeSessionStore();
    const legacy = { key: KEY, name: "a.tif", savedAt: 5, classes: [{ name: "A", colour: "#000000" }], selected: 0, opacity: 0.4, visible: true,
      base: { lut: new Uint8Array(4), count: 3, windows: ["0,0"], values: new Uint8Array(4) } };
    fake.records.set(KEY, legacy as unknown as SessionRecord);
    const bytes = Uint8Array.from({ length: 256 * 256 }, (_, i) => i % 251);
    fake.tiles.set(KEY, new Map([["0,0", bytes.slice().buffer], ["256,0", tile(2).buffer]]));
    const copy = new Blob(["the copy"]);
    fake.bases.set(KEY, copy);
    const t = setup(fake);
    expect(await t.open()).toBe(MESSAGES.restored);
    expect(t.store().tiles.get("0,0")).toEqual(bytes);
    expect(t.store().tiles.get("256,0")).toEqual(tile(2));
    expect((t.base()!.file as unknown as { blob: Blob }).blob).toBe(copy);
    // later saves go to the same session, now in this version's shape
    t.paint("0,0", 7); await t.flush();
    expect(fake.records.get(KEY)).toMatchObject({ id: KEY, raster: KEY, role: "current", exportedAt: null });
  });
});

describe("export marks the session (scope 6)", () => {
  it("exported() saves exportedAt with savedAt unchanged; without it nothing is marked", async () => {
    const t = setup();
    await t.open();
    t.paint("0,0", 1); await t.flush();
    const savedAt = t.fake.records.get(KEY)!.savedAt;
    expect(t.fake.records.get(KEY)!.exportedAt).toBe(null);
    t.p.exported(savedAt + 500);
    await t.flush();
    expect(t.fake.records.get(KEY)).toMatchObject({ savedAt, exportedAt: savedAt + 500 });
    t.paint("0,0", 2); await t.flush(); // a change after the export
    const r = t.fake.records.get(KEY)!;
    expect(r.savedAt).toBeGreaterThan(r.exportedAt!);
  });
});

describe("an export covering unsaved changes (scope 6)", () => {
  it("changes made before the export's click and not saved yet are saved as of the export, so the session counts as exported", async () => {
    const t = setup();
    await t.open();
    t.paint("0,0", 1); await t.flush();
    t.paint("256,0", 2); // not saved yet when Export is clicked
    t.tick(100);
    t.p.exported(5000);
    await t.p.idle();
    const r = t.fake.records.get(KEY)!;
    expect([...t.fake.tiles.get(KEY)!.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(r).toMatchObject({ savedAt: 5000, exportedAt: 5000 });
  });
});

describe("a previous raster's pending copy (scope 3)", () => {
  it("is retried at most 3 times too, then its record is saved without it", async () => {
    const t = setup();
    let calls = 0;
    t.fake.store.saveBase = async () => { calls++; throw new DOMException("The file changed.", "NotReadableError"); };
    await t.open();
    await t.importMask(5, "0,0", 1);
    t.p.open("b.tif", SIZE + 1, G); // saved at once, and its copy fails: pending
    await t.p.idle(); await t.p.offer();
    for (let ms = 0; ms < 10 * 60_000; ms += 5000) await t.flush(5000);
    expect(calls).toBeLessThanOrEqual(4);
    expect(t.fake.records.get(KEY)!.base!.copyMissing).toBe(true);
  });
});

describe("the open raster's save while a previous raster's copy keeps failing (scope 3)", () => {
  it("raster B's tiles, record and own copy are saved, and A's failures count only against A", async () => {
    const t = setup();
    const save = t.fake.store.saveBase.bind(t.fake.store);
    let aCalls = 0;
    t.fake.store.saveBase = async (k, f) => {
      if (k === KEY) { aCalls++; throw new DOMException("The file changed.", "NotReadableError"); }
      return save(k, f);
    };
    await t.open();
    await t.importMask(5, "0,0", 1);
    t.p.open("b.tif", SIZE + 1, G); // A's save starts now; its copy fails, so it is pending
    await t.p.idle(); await t.p.offer();
    const B = [...t.fake.records.keys()].find((k) => k !== KEY) ?? "";
    expect(B).toBe(""); // B has nothing saved yet
    await t.importMask(9, "512,256", 3); // B's own mask, while A is pending
    t.paint("768,256", 4);
    for (let ms = 0; ms < 10 * 60_000; ms += 5000) await t.flush(5000);
    const b = [...t.fake.records.values()].find((r) => r.id !== KEY)!;
    expect([...t.fake.tiles.get(b.id)!.keys()].sort()).toEqual(["512,256", "768,256"]);
    expect(b.base!.count).toBe(9);
    expect(b.base!.copyMissing).toBeUndefined();
    expect(await t.fake.bases.get(b.id)!.text()).toBe("mask 9");
    expect(aCalls).toBeLessThanOrEqual(4);
    expect(t.fake.records.get(KEY)!.base!.copyMissing).toBe(true);
  });
});

describe("a previous raster's snapshot that keeps failing (spec 031 scope 8)", () => {
  it("doesn't block the open raster's saves, and stays queued for its retry", async () => {
    const t = setup();
    let failA = true;
    const putTiles = t.fake.store.putTiles.bind(t.fake.store);
    t.fake.store.putTiles = async (id, list) => { if (id === KEY && failA) throw new Error("A's tiles fail"); return putTiles(id, list); };
    await t.open();
    t.paint("0,0", 1);
    t.p.open("b.tif", SIZE + 1, G); // A's save fails: pending
    await t.p.idle(); await t.p.offer();
    t.paint("256,256", 2);
    await t.flush();
    const b = [...t.fake.records.values()].find((r) => r.id !== KEY)!;
    expect([...t.fake.tiles.get(b.id)!.keys()]).toEqual(["256,256"]);
    expect(t.fake.records.has(KEY)).toBe(false);
    failA = false;
    await t.flush(30_000); // the retry writes A
    expect([...t.fake.tiles.get(KEY)!.keys()]).toEqual(["0,0"]);
    expect(t.fake.records.has(KEY)).toBe(true);
  });
});
