import { describe, expect, it } from "vitest";
import { emptyStore } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { openLabelFile, type LabelSource } from "../../../src/io/labelFile";
import type { MaskBase } from "../../../src/io/maskBase";
import { initPersist, type PersistLabels } from "../../../src/ui/persist";
import { CLASS_GRID, classFile } from "../helpers/labelFiles";
import { fakeSessionStore } from "../helpers/sessionStore";

// Spec 074 criterion 4 (ADR 0041): once the copy is written whole, the base reads it and never the user's file again.
const G: Grid = CLASS_GRID;

/** The user's file: counts reads, and fails them as Chrome does once it changed on disk. */
class UserFile extends Blob {
  reads = 0; changed = false;
  override slice(...a: Parameters<Blob["slice"]>): Blob {
    this.reads++;
    if (this.changed) throw new DOMException("The file changed.", "NotReadableError");
    return super.slice(...a);
  }
}

function setup(copyOf: (file: Blob) => Promise<Blob>) {
  const fake = fakeSessionStore();
  fake.store.saveBase = async (k, f) => { fake.bases.set(k, await copyOf(f)); };
  let base: MaskBase | null = null;
  const store = emptyStore(G.width, G.height);
  const labels: PersistLabels = {
    store: () => store, classes: () => [{ name: "A", colour: "#000000" }], selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => base,
    stroking: () => false, hasLabels: () => true, restoreSession() {},
  };
  const p = initPersist({ labels, open: async () => fake.store, state: { textContent: "" }, win: new EventTarget(),
    doc: Object.assign(new EventTarget(), { visibilityState: "visible" }), yieldTask: async () => {}, confirm: () => true, time: () => "t" });
  /** An import of `file`, wired as main wires it: the copy, once whole, replaces the live base's file. */
  async function importFile(file: UserFile) {
    const b: MaskBase = { file: await openLabelFile(file), lut: new Uint8Array(256), count: 1, windows: new Set(["0,0"]), preview: { values: new Uint8Array(1) } as never };
    base = b;
    p.replaced();
    p.imported(file, async (copy) => { if (base === b) b.file = await openLabelFile(copy); });
    return b;
  }
  return { fake, p, importFile, base: () => base };
}

const W = { x0: 0, y0: 0, width: 64, height: 64 };
const bytes = () => new UserFile([classFile()]);
const read = (f: LabelSource) => f.read(W);

// real timers: geotiff.js and the blob reader schedule their own tasks
describe("the base reads the app's copy (criterion 4)", () => {
  it("after the copy is written, base().file reads the copy's blob, and the user's file is never read again", async () => {
    const t = setup(async (f) => new Blob([await f.arrayBuffer()]));
    t.p.open("a.tif", 1, G); await t.p.offer();
    const user = bytes();
    const b = await t.importFile(user);
    const original = b.file, before = await read(original);
    t.p.flush(); await t.p.idle(); // a save now, as the 2 s timer would
    expect(t.base()).toBe(b);
    expect(b.file).not.toBe(original);
    user.changed = true; // e.g. a Save dialog emptied it
    const reads = user.reads;
    expect(await read(t.base()!.file)).toEqual(before);
    expect(user.reads).toBe(reads);
  });

  it("a copy whose size differs from the source is not used", async () => {
    const t = setup(async (f) => new Blob([(await f.arrayBuffer()).slice(0, 100)]));
    t.p.open("a.tif", 1, G); await t.p.offer();
    const user = bytes();
    const b = await t.importFile(user);
    const file = b.file;
    t.p.flush(); await t.p.idle(); // a save now, as the 2 s timer would
    expect(t.base()!.file).toBe(file);
  });

  it("waitCopy resolves once the copy is in use, and at once when no copy is due or it failed", async () => {
    const t = setup(async (f) => new Blob([await f.arrayBuffer()]));
    t.p.open("a.tif", 1, G); await t.p.offer();
    await t.p.waitCopy(); // nothing imported
    const b = await t.importFile(bytes());
    const file = b.file;
    await t.p.waitCopy(); // no 2 s wait: it saves now
    expect(t.base()!.file).not.toBe(file);

    const f = setup(async () => { throw new DOMException("The file changed.", "NotReadableError"); });
    f.p.open("a.tif", 1, G); await f.p.offer();
    await f.importFile(bytes());
    await f.p.waitCopy();
    expect(f.fake.bases.size).toBe(0);
    let settled = false;
    void f.p.waitCopy().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(true); // a failed copy isn't waited for again
  });
});
