import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialClasses, type LabelClass } from "../../../src/core/classes";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { checkLabelExport } from "../../../src/io/labelExport";
import type { LabelSource } from "../../../src/io/labelFile";
import type { MaskBase } from "../../../src/io/maskBase";
import { runExport, type ExportDeps } from "../../../src/ui/exportLabels";
import { MESSAGES } from "../../../src/ui/messages";
import { initPersist, SAVE_DELAY_MS, type PersistLabels } from "../../../src/ui/persist";
import { fakeFolder } from "../helpers/fakeFolder";
import { fakeSessionStore } from "../helpers/sessionStore";
import { fakeSource } from "../helpers/sources";

// Tester: adversarial cases for specs 055 and 056 beyond the implementer's tests.

const G: Grid = { width: 1000, height: 700, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] };
const tile = (v: number) => new Uint8Array(256 * 256).fill(v);
const maskBase = (count: number) => ({ lut: new Uint8Array(4), count, windows: new Set(["0,0"]), preview: { values: new Uint8Array(4) } }) as unknown as MaskBase;

function persistSetup(fake = fakeSessionStore(), answers: boolean[] = []) {
  let store: LabelStore = emptyStore(G.width, G.height), base: MaskBase | null = null;
  const classes: LabelClass[] = [{ name: "Class 1", colour: "#1f77b4" }];
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => base,
    stroking: () => false, hasLabels: () => store.tiles.size > 0 || (base?.count ?? 0) > 0,
    restoreSession(s, _c, b) { store = s; base = b; },
  };
  let clock = 1000;
  const p = initPersist({
    labels, open: async () => fake.store, state: { textContent: "" }, win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    yieldTask: async () => {}, now: () => clock, time: () => "12:00", dateTime: (ms) => `t${ms}`, say: () => {},
    openBase: async (blob) => ({ meta: { width: G.width, height: G.height }, blob } as unknown as LabelSource),
    confirm: () => answers.shift() ?? true,
  });
  const paint = (k: string, v: number) => { store.tiles.set(k, tile(v)); p.tiles([k]); };
  const flush = async (ms = SAVE_DELAY_MS) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); await p.idle(); };
  /** As seeding does: refusal check, flush, then (awaited or not) the replace. */
  const importMask = async (count: number, key: string, v: number, awaitFlush = true): Promise<string | null> => {
    const refused = labels.hasLabels() ? p.replaceRefused() : null;
    if (refused) return refused;
    p.flush();
    if (awaitFlush) await p.idle();
    store = emptyStore(G.width, G.height); store.tiles.set(key, tile(v)); base = maskBase(count);
    p.replaced(); p.imported(new Blob([`mask ${count}`]));
    return null;
  };
  return { fake, p, paint, flush, importMask, open: async () => { p.open("a.tif", 4321, G); return p.offer(); }, now: () => clock };
}

describe("spec 056 scope 2: a replaced session changed after its export is never dropped", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("export A, paint more, the flush save fails, import B: a third import is refused (A's last change is after its export)", async () => {
    const t = persistSetup();
    await t.open();
    await t.importMask(5, "0,0", 1); await t.flush();
    t.p.exported(t.now()); await t.flush();
    t.paint("256,0", 2); // changed after the export
    t.fake.failWith(new Error("disk"));
    await t.importMask(9, "512,256", 3); // its flush fails
    t.fake.failWith(null);
    await t.flush(30_000);
    expect(await t.importMask(7, "0,256", 4)).toBe(MESSAGES.replacedFirst);
  });

  it("export A, paint more, import B before the flush save ends: a third import is refused", async () => {
    const t = persistSetup();
    await t.open();
    await t.importMask(5, "0,0", 1); await t.flush();
    t.p.exported(t.now()); await t.flush();
    t.paint("256,0", 2);
    await t.importMask(9, "512,256", 3, false); // the replace lands while the flush is still writing
    await t.flush();
    expect(await t.importMask(7, "0,256", 4)).toBe(MESSAGES.replacedFirst);
  });

  it("an export covering unsaved changes still lets a third import drop A (the fix is not over-conservative)", async () => {
    const t = persistSetup();
    await t.open();
    await t.importMask(5, "0,0", 1); await t.flush();
    t.paint("256,0", 2); // unsaved at the export's click
    t.p.exported(t.now() + 100);
    await t.flush();
    await t.importMask(9, "512,256", 3); await t.flush();
    expect(await t.importMask(7, "0,256", 4)).toBe(null);
  });

  it("A exported, then a failed save of B's import, then a reload-free third import: A's post-export tile is stored before any drop", async () => {
    const t = persistSetup();
    await t.open();
    await t.importMask(5, "0,0", 1); await t.flush();
    t.p.exported(t.now()); await t.flush();
    t.paint("256,0", 2);
    t.fake.failWith(new Error("disk"));
    await t.importMask(9, "512,256", 3);
    t.fake.failWith(null);
    await t.flush(30_000);
    const a = [...t.fake.records.values()].find((r) => r.role === "replaced")!;
    expect(a.savedAt).toBeGreaterThan(a.exportedAt!);
    expect(t.fake.tiles.get(a.id)!.has("256,0")).toBe(true);
  });
});

describe("spec 056 scope 3: a replaced session's pending copy failures don't use up the new import's copy retries", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([0, 1])("A's save fails, B is imported, A's copy keeps failing; B's own copy fails %i time(s): B's copy is still written and B's record isn't copyMissing", async (fails) => {
    const t = persistSetup();
    const save = t.fake.store.saveBase.bind(t.fake.store);
    let bFails = fails; // B's own copy fails this often, then works (well within its 3 retries)
    t.fake.store.saveBase = async (k, f) => {
      const text = await f.text();
      if (text === "mask 5") throw new DOMException("The file changed.", "NotReadableError");
      if (text === "mask 9" && bFails-- > 0) throw new DOMException("The file changed.", "NotReadableError");
      return save(k, f);
    };
    await t.open();
    t.fake.failWith(new Error("disk"));
    await t.importMask(5, "0,0", 1);
    await t.flush(); // A's first save fails: its tiles and copy are still due
    await t.importMask(9, "512,256", 3); // A becomes the replaced session, pending with its copy
    t.fake.failWith(null);
    for (let ms = 0; ms < 10 * 60_000; ms += 5000) await t.flush(5000);
    const b = [...t.fake.records.values()].find((r) => r.role === "current")!;
    const a = [...t.fake.records.values()].find((r) => r.role === "replaced")!;
    expect(a.base!.copyMissing).toBe(true);
    expect([...t.fake.tiles.get(a.id)!.keys()]).toEqual(["0,0"]);
    expect(b.base!.copyMissing).toBeUndefined();
    expect(await t.fake.bases.get(b.id)?.text()).toBe("mask 9");
  });
});

describe("spec 056 scope 2 with c1c1d6c's queue order: a dropped replaced session is not written back by its own retry", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("A exported while its saves fail, B imported (A pending, its copy failing), C imported (drops A): A never comes back", async () => {
    const t = persistSetup();
    const save = t.fake.store.saveBase.bind(t.fake.store);
    t.fake.store.saveBase = async (k, f) => {
      if (await f.text() === "mask 5") throw new DOMException("The file changed.", "NotReadableError");
      return save(k, f);
    };
    await t.open();
    t.fake.failWith(new Error("disk"));
    await t.importMask(5, "0,0", 1);
    await t.flush(); // A's save fails
    t.p.exported(t.now()); // a verified folder export of A
    await t.flush();
    await t.importMask(9, "512,256", 3); // A is replaced, its failed snapshot pending
    t.fake.failWith(null);
    await t.flush(30_000); // A's tiles and record are written, its copy fails: still pending; B is written
    expect(await t.importMask(7, "0,256", 4)).toBe(null); // A was exported after its last change: C drops it
    for (let ms = 0; ms < 10 * 60_000; ms += 5000) await t.flush(5000);
    const counts = (r: string) => [...t.fake.records.values()].filter((x) => x.role === r).map((x) => x.base!.count);
    expect(counts("current")).toEqual([7]);
    expect(counts("replaced")).toEqual([9]); // only B; A, dropped, is not resurrected by its pending retry
  });
});

describe("867d906's delete stamps: a re-used id after a declined restore still saves", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("delete on Cancel then OK, paint, save fails, open another raster (pending), storage recovers: the re-used id is written", async () => {
    const a = persistSetup();
    await a.open(); a.paint("0,0", 1); await a.flush();
    const id = [...a.fake.records.keys()][0]!;
    const t = persistSetup(a.fake, [false, true]); // Cancel, then OK: deleted
    expect(await t.open()).toBe(null);
    expect(a.fake.records.size).toBe(0);
    t.paint("256,0", 2);
    t.fake.failWith(new Error("disk"));
    await t.flush();
    t.p.open("b.tif", 999, G); // the failed snapshot of the re-used id becomes pending
    await t.p.idle(); await t.p.offer();
    t.fake.failWith(null);
    for (let ms = 0; ms < 2 * 60_000; ms += 5000) await t.flush(5000);
    expect(a.fake.records.has(id)).toBe(true);
    expect([...a.fake.tiles.get(id)!.keys()]).toEqual(["256,0"]);
  });
});

// Spec 055 scope 3: on Windows, folder names are case-insensitive, so ORTHO.tif opens the imagery ortho.tif
function caseInsensitive(f: ReturnType<typeof fakeFolder>) {
  const real = f.dir.getFileHandle.bind(f.dir);
  f.dir.getFileHandle = (async (n: string, o?: { create?: boolean }) => {
    const hit = ["ortho.tif", "labels.tif"].find((x) => x.toLowerCase() === n.toLowerCase());
    if (!hit) return real(n, o);
    const h = await real(hit, o);
    return Object.assign(Object.create(h), { name: n, createWritable: h.createWritable, isSameEntry: h.isSameEntry, getFile: h.getFile });
  }) as typeof f.dir.getFileHandle;
  return f;
}

describe("spec 055 scope 3: the imagery and the uncopied mask are refused whatever the name's case", () => {
  const { source } = fakeSource({ width: 600, height: 300 }, () => 1);
  afterEach(() => { vi.unstubAllGlobals(); });

  function deps(f: ReturnType<typeof fakeFolder>, o: Partial<ExportDeps>) {
    const said: string[] = [], confirms: string[] = [];
    vi.stubGlobal("showDirectoryPicker", async () => f.dir);
    const d: ExportDeps = {
      imagery: source, store: emptyStore(600, 300), classes: initialClasses(), base: null, startIn: null, imageryFile: null,
      mask: () => null, waitCopy: async () => {}, prompt: () => "labels.tif", confirm: (t) => { confirms.push(t); return true; },
      say: (t) => { said.push(t); }, error: (e) => String(e), exported: () => {}, ...o,
    };
    return { d, said, confirms };
  }

  it("ORTHO.tif, without a handle, is refused as the imagery ortho.tif", async () => {
    const f = caseInsensitive(fakeFolder({ "ortho.tif": new Uint8Array([1, 2, 3]) }));
    const t = deps(f, { prompt: () => "ORTHO.tif", imageryFile: { handle: null, name: "ortho.tif", size: 3 } });
    await runExport(t.d);
    expect(t.said).toEqual([MESSAGES.exportImagery]);
    expect(f.bytes("ortho.tif")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("LABELS.TIF, without a handle and before the copy exists, is refused as the imported mask", async () => {
    const f = caseInsensitive(fakeFolder({ "labels.tif": new Uint8Array([7, 7]) }));
    const t = deps(f, { prompt: () => "LABELS.TIF", mask: () => ({ handle: null, name: "labels.tif", size: 2, copied: false }) });
    await runExport(t.d);
    expect(t.said).toEqual([MESSAGES.exportMask]);
    expect(f.bytes("labels.tif")).toEqual(new Uint8Array([7, 7]));
  });

  it("control: the same-case name is refused (size check runs)", async () => {
    const f = fakeFolder({ "ortho.tif": new Uint8Array([1, 2, 3]) });
    const t = deps(f, { prompt: () => "ortho.tif", imageryFile: { handle: null, name: "ortho.tif", size: 3 } });
    await runExport(t.d);
    expect(t.said).toEqual([MESSAGES.exportImagery]);
    expect(checkLabelExport(source, initialClasses()).totalBytes).toBeGreaterThan(3);
  });
});
