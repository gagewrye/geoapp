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

function persistSetup(fake = fakeSessionStore()) {
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
    confirm: () => true,
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
