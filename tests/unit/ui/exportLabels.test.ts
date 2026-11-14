import { afterEach, describe, expect, it, vi } from "vitest";
import { initialClasses } from "../../../src/core/classes";
import { emptyStore } from "../../../src/core/labelStore";
import { checkLabelExport } from "../../../src/io/labelExport";
import type { MaskBase } from "../../../src/io/maskBase";
import { runExport, type ExportDeps } from "../../../src/ui/exportLabels";
import { MESSAGES } from "../../../src/ui/messages";
import { fakeFolder } from "../helpers/fakeFolder";
import { fakeSource } from "../helpers/sources";

// Spec 055 criteria 2 and 3, and scope 3's target checks, with fake handles.
const { source } = fakeSource({ width: 600, height: 300 }, () => 1);
const TOTAL = checkLabelExport(source, initialClasses()).totalBytes;

function setup(folder = fakeFolder(), o: Partial<ExportDeps> & { answer?: string | null; pick?: () => Promise<unknown> } = {}) {
  const said: [string, string | undefined][] = [], prompts: string[] = [], confirms: string[] = [], exports: number[] = [];
  const saves: unknown[] = [], picks: unknown[] = [];
  vi.stubGlobal("showSaveFilePicker", (x: unknown) => { saves.push(x); return Promise.reject(new Error("save picker")); });
  vi.stubGlobal("showDirectoryPicker", (x: unknown) => { picks.push(x); return (o.pick ?? (async () => folder.dir))(); });
  const store = emptyStore(600, 300);
  store.tiles.set("0,0", new Uint8Array(256 * 256).fill(2));
  const d: ExportDeps = {
    imagery: source, store, classes: initialClasses(), base: null, startIn: null, imageryFile: null,
    mask: () => null, waitCopy: async () => {},
    prompt: (t) => { prompts.push(t); return o.answer === undefined ? "labels.tif" : o.answer; },
    confirm: (t) => { confirms.push(t); return true; },
    say: (t, k) => { said.push([t, k]); }, error: (e) => (e as Error).message, exported: (at) => { exports.push(at); }, now: () => 42,
    ...o,
  };
  return { d, folder, said, prompts, confirms, exports, saves, picks, run: () => runExport(d) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("the folder path (criterion 2)", () => {
  it("never calls showSaveFilePicker when showDirectoryPicker exists; writes the new file, checks its size and marks the session", async () => {
    const t = setup();
    await t.run();
    expect(t.saves).toEqual([]);
    expect(t.picks).toEqual([{ mode: "readwrite" }]);
    expect(t.prompts).toEqual([MESSAGES.saveAs]);
    expect(t.folder.bytes("labels.tif")!.length).toBe(TOTAL);
    expect(t.said.at(-1)).toEqual([MESSAGES.exportedTo("labels.tif", TOTAL), undefined]);
    expect(t.exports).toEqual([42]);
  });

  it("starts in spec 050's handle and adds a missing .tif", async () => {
    const h = { kind: "file", name: "Chunk1_1.tif" } as unknown as FileSystemHandle;
    const t = setup(fakeFolder(), { startIn: h, answer: "final" });
    await t.run();
    expect(t.picks).toEqual([{ mode: "readwrite", startIn: h }]);
    expect(t.folder.has("final.tif")).toBe(true);
  });

  it("a picker AbortError or a null prompt writes nothing and says nothing", async () => {
    const a = setup(fakeFolder(), { pick: () => Promise.reject(new DOMException("aborted", "AbortError")) });
    await a.run();
    expect(a.said).toEqual([]);
    expect(a.prompts).toEqual([]);
    const b = setup(fakeFolder(), { answer: null });
    await b.run();
    expect(b.said).toEqual([]);
    expect(b.folder.log).toEqual([]);
    expect(b.exports).toEqual([]);
  });

  it("a refused name is said, and nothing is written", async () => {
    const t = setup(fakeFolder(), { answer: "a/b" });
    await t.run();
    expect(t.said).toEqual([[MESSAGES.badName, "error"]]);
    expect(t.folder.log).toEqual([]);
  });
});

describe("target checks (scope 3)", () => {
  const old = () => fakeFolder({ "labels.tif": new Uint8Array([7, 7]), "ortho.tif": new Uint8Array([1, 2, 3]) });

  it("refuses the imagery by isSameEntry, and by name and size without a handle", async () => {
    const f = old();
    const a = setup(f, { answer: "ortho.tif", imageryFile: { handle: f.handle("ortho.tif"), name: "x", size: 0 } });
    await a.run();
    expect(a.said).toEqual([[MESSAGES.exportImagery, "error"]]);
    const b = setup(f, { answer: "ortho.tif", imageryFile: { handle: null, name: "ortho.tif", size: 3 } });
    await b.run();
    expect(b.said).toEqual([[MESSAGES.exportImagery, "error"]]);
    expect(f.bytes("ortho.tif")).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.log).toEqual([]);
  });

  it("refuses the imported mask before its copy exists; once copied it asks to replace, after waiting for the copy", async () => {
    const f = old();
    let copied = false;
    const mask = () => ({ handle: f.handle("labels.tif"), name: "labels.tif", size: 2, copied });
    const a = setup(f, { mask });
    await a.run();
    expect(a.said).toEqual([[MESSAGES.exportMask, "error"]]);
    expect(a.confirms).toEqual([]);
    const b = setup(f, { mask, waitCopy: async () => { copied = true; } });
    await b.run();
    expect(b.confirms).toEqual([MESSAGES.exportReplace("labels.tif")]);
    expect(f.bytes("labels.tif")!.length).toBe(TOTAL);
  });

  it("asks before replacing any other file; Cancel writes nothing", async () => {
    const f = old();
    const t = setup(f, { confirm: () => false });
    await t.run();
    expect(f.bytes("labels.tif")).toEqual(new Uint8Array([7, 7]));
    expect(f.log).toEqual([]);
    expect(t.said).toEqual([]);
  });
});

describe("a write that fails (criterion 3)", () => {
  it("aborts and never closes; the old file, labels and base are unchanged (the flow holds no undo history); the message ends Nothing was overwritten.", async () => {
    const f = fakeFolder({ "labels.tif": new Uint8Array([7, 7]) }, { failAfter: 3 }); // the header, then tiles 1 and 2: tile 3 throws
    const base = { lut: new Uint8Array(256), count: 0, windows: new Set<string>(), preview: {} } as unknown as MaskBase;
    const t = setup(f, { base });
    const tiles = new Map(t.d.store.tiles);
    await t.run();
    expect(f.log).toEqual(["createWritable labels.tif", "abort labels.tif"]);
    expect(f.bytes("labels.tif")).toEqual(new Uint8Array([7, 7]));
    expect(t.d.store.tiles).toEqual(tiles);
    expect(t.d.base).toBe(base);
    expect(t.exports).toEqual([]);
    const [text, kind] = t.said.at(-1)!;
    expect(kind).toBe("error");
    expect(text.endsWith(MESSAGES.nothingOverwritten)).toBe(true);
  });

  it("a size mismatch after close names the file and marks nothing", async () => {
    const f = fakeFolder();
    const t = setup(f);
    const real = f.dir.getFileHandle.bind(f.dir);
    f.dir.getFileHandle = (async (n: string, o?: { create?: boolean }) => {
      const h = await real(n, o);
      return Object.assign(Object.create(h), { createWritable: h.createWritable, isSameEntry: h.isSameEntry, getFile: async () => new File([new Uint8Array(5)], n) });
    }) as typeof f.dir.getFileHandle;
    await t.run();
    expect(t.said.at(-1)).toEqual([MESSAGES.exportShort("labels.tif", 5, TOTAL), "error"]);
    expect(t.exports).toEqual([]);
  });
});
