import { describe, expect, it } from "vitest";
import { initialClasses } from "../../../src/core/classes";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, MAX_LABEL_TILES, type LabelStore } from "../../../src/core/labelStore";
import { footprint } from "../../../src/core/pixel";
import type { Affine, Grid } from "../../../src/core/types";
import { maskReadFailed } from "../../../src/io/labelFile";
import { PaintQueue } from "../../../src/io/paintQueue";
import { importLabels } from "../../../src/io/seeding";
import { UndoHistory } from "../../../src/io/undoHistory";
import { MESSAGES, readErrorMessage } from "../../../src/ui/messages";
import { effectiveTiles } from "../helpers/effective";
import { fakeLabelSource } from "../helpers/labelFiles";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

// Spec 014 criteria 8 (the cap with a base) and 12 (the mask file gone, for a cell), and copy on touch at the io level.

const SIDE = 256 * 17; // 289 tiles, for the cap; other tests use 1024 x 1024
const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
/** Mask: 4 (label 1) where (c + r) is even, else 6 (label 2); imagery all valid. */
const maskValue = (c: number, r: number) => ((c + r) % 2 ? 6 : 4);
const TABLE = [{ value: 4, name: "four" }, { value: 6, name: "six" }];

async function setup(side = 1024) {
  const grid: Grid = { width: side, height: side, epsg: 32633, gt };
  const imagery = fakeSource({ ...grid, bandCount: 1 }, () => 1);
  const file = fakeLabelSource(grid, maskValue);
  const r = await importLabels(imagery.source, file.source, TABLE, { store: emptyStore(side, side), classes: initialClasses() }, "replace");
  if (typeof r === "string") throw new Error(r);
  const store: LabelStore = r.store;
  const history = new UndoHistory(() => store);
  const events = { full: 0, errors: [] as unknown[] };
  const q = new PaintQueue(imagery.source, () => store, {
    applied: () => {}, full: () => { events.full++; }, busy: () => {}, error: (e) => { events.errors.push(e); },
  }, history, () => r.base);
  /** One ended stroke of 1x1 (or side) cells. */
  const strokeAt = async (cells: [number, number][], value: number, erase = false, side = 1) => {
    const s = history.begin();
    for (const [c, rr] of cells) q.push({ w: footprint(store, c, rr, side)!, value, erase, stroke: s });
    history.end(s);
    await idle(q);
  };
  return { imagery, file, r, store, history, q, events, strokeAt };
}

const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));

describe("copy on touch (spec 014 Rules)", () => {
  it("a paint dab across a tile corner copies the 4 base tiles; only the dab's pixels change; undo shows the mask again", { timeout: 60_000 }, async () => {
    const t = await setup();
    const before = await effectiveTiles(t.imagery.source, { store: t.store, base: t.r.base });
    await t.strokeAt([[256, 256]], 2, false, 7);
    expect([...t.store.tiles.keys()].sort()).toEqual(["0,0", "0,256", "256,0", "256,256"]);
    const after = await effectiveTiles(t.imagery.source, { store: t.store, base: t.r.base });
    for (const w of tileWindows(1024, 1024)) {
      const k = `${w.x0},${w.y0}`, a = after.get(k)!, b = before.get(k)!;
      for (let i = 0; i < a.length; i++) {
        const c = w.x0 + (i % w.width), r = w.y0 + Math.floor(i / w.width);
        const inDab = c >= 253 && c <= 259 && r >= 253 && r <= 259;
        if (a[i] !== (inDab ? 2 : b[i])) throw new Error(`${c},${r}: ${a[i]}`);
      }
    }
    expect(t.history.undo()).toEqual(["0,0", "256,0", "0,256", "256,256"]);
    expect(t.store.tiles.size).toBe(0);
  });

  it("an erase copies the base tile and clears only the selected class, mask pixels included", { timeout: 60_000 }, async () => {
    const t = await setup();
    await t.strokeAt([[600, 600]], 1, true, 7);
    expect([...t.store.tiles.keys()]).toEqual(["512,512"]);
    const tile = t.store.tiles.get("512,512")!;
    for (let r = 597; r <= 603; r++) for (let c = 597; c <= 603; c++) expect(tile[(r - 512) * 256 + (c - 512)]).toBe((c + r) % 2 ? 2 : 0);
    expect(tile[0]).toBe(1);
    expect(tile[1]).toBe(2);
  });
});

describe("the cap with a base (criterion 8)", () => {
  it("at 256 stored tiles a cell touching a 257th base tile shows the message and changes nothing; after an Undo frees a tile it applies", { timeout: 120_000 }, async () => {
    const t = await setup(SIDE);
    const windows = tileWindows(SIDE, SIDE);
    for (const w of windows.slice(0, MAX_LABEL_TILES - 1)) t.store.tiles.set(`${w.x0},${w.y0}`, new Uint8Array(w.width * w.height).fill(2));
    const [w256, w257] = [windows[MAX_LABEL_TILES - 1]!, windows[MAX_LABEL_TILES]!];
    await t.strokeAt([[w256.x0 + 5, w256.y0 + 5]], 2); // copies the 256th tile
    expect(t.store.tiles.size).toBe(MAX_LABEL_TILES);
    const held = snapshot(t.store);
    await t.strokeAt([[w257.x0 + 5, w257.y0 + 5]], 2);
    expect(t.events.full).toBe(1);
    expect(snapshot(t.store)).toEqual(held);
    expect(t.history.size).toBe(1); // the refused stroke changed nothing, so it isn't an undo step
    expect(t.history.undo()).toEqual([`${w256.x0},${w256.y0}`]);
    expect(t.store.tiles.size).toBe(MAX_LABEL_TILES - 1);
    await t.strokeAt([[w257.x0 + 5, w257.y0 + 5]], 2);
    expect(t.events.full).toBe(1);
    const tile = t.store.tiles.get(`${w257.x0},${w257.y0}`)!;
    expect(tile[5 * 256 + 5]).toBe(2);
    expect(tile[0]).toBe(1); // the rest is the base
    expect(MESSAGES.editLimit).toBe("Label limit reached (256 edited tiles of 256 x 256 px). Undo strokes, or export the labels and import the export with Replace.");
  });
});

describe("the mask file gone (criterion 12, a cell)", () => {
  for (const name of ["NotReadableError", "NotFoundError"]) {
    it(`a copy-on-touch cell whose read rejects with ${name} fails with the message, store and classes unchanged`, { timeout: 60_000 }, async () => {
      const t = await setup();
      await t.strokeAt([[10, 10]], 2); // one tile copied while the file was readable
      const held = snapshot(t.store), classes = structuredClone(t.r.classes);
      t.r.base.file.read = async () => { throw new DOMException("changed", name); };
      await t.strokeAt([[1000, 1000]], 1);
      expect(t.events.errors).toHaveLength(1);
      expect(maskReadFailed(t.events.errors[0])).toBe(true);
      expect(readErrorMessage(t.events.errors[0])).toBe("The label mask can't be read any more. Import it again.");
      expect(snapshot(t.store)).toEqual(held);
      expect(t.r.classes).toEqual(classes);
      expect(t.q.size).toBe(0);
    });
  }

  it("other errors keep their own message", () => {
    expect(readErrorMessage(new Error("boom"))).toBe("boom");
  });
});
