import { fromArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { initialClasses } from "../../../src/core/classes";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore } from "../../../src/core/labelStore";
import type { Affine, Grid } from "../../../src/core/types";
import { exportLabels } from "../../../src/io/labelExport";
import type { LabelSource } from "../../../src/io/labelFile";
import { importLabels } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { readErrorMessage } from "../../../src/ui/messages";
import { effectiveTiles } from "../helpers/effective";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource, recordingSink } from "../helpers/sources";

// Spec 014 criteria 9 (the export, io) and 12 (the mask file gone, for an export).

const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
const GRID: Grid = { width: 1000, height: 700, epsg: 32633, gt };
const inNodata = (c: number, r: number) => c >= 300 && c < 340 && r >= 100 && r < 130;
/** The mask labels only x < 800 (so windows x0 = 768 are partial and 0 elsewhere). */
const maskValue = (c: number, r: number) => (c >= 800 ? 0 : 1 + ((c >> 5) + (r >> 5)) % 3);
const TABLE = [1, 2, 3].map((v) => ({ value: v, name: `v${v}` }));

async function setup() {
  const img = fakeSource({ ...GRID, bandCount: 2, nodata: -1 }, (b, c, r) => (b === 1 && inNodata(c, r) ? -1 : 7));
  const file = fakeLabelSource(GRID, maskValue);
  const log: string[] = [];
  const imagery: RasterSource = { meta: img.source.meta, readWindow: (x0, y0, w, h) => { log.push(`i ${x0},${y0}`); return img.source.readWindow(x0, y0, w, h); } };
  const f: LabelSource = { ...file.source, read: (w) => { log.push(`f ${w.x0},${w.y0}`); return file.source.read(w); } };
  const r = await importLabels(imagery, f, TABLE, { store: emptyStore(1000, 700), classes: initialClasses() }, "replace");
  if (typeof r === "string") throw new Error(r);
  // edits: a changed copy of a base tile, a zeroed tile hiding the mask, and a tile where the mask is empty
  const ws = tileWindows(1000, 700);
  const edited = (await effectiveTiles(imagery, r)).get("256,0")!.slice();
  edited.fill(3, 0, 1000);
  r.store.tiles.set("256,0", edited);
  r.store.tiles.set("512,256", new Uint8Array(65536));
  const far = ws.find((w) => w.x0 === 768 && w.y0 === 512)!;
  r.store.tiles.set("768,512", new Uint8Array(far.width * far.height).fill(2));
  log.length = 0;
  return { imagery, f, r, log };
}

describe("Export labels with a mask (criterion 9, io)", () => {
  it("writes the effective tiles; stored windows read no file or imagery window", { timeout: 60_000 }, async () => {
    const { imagery, r, log } = await setup();
    const want = await effectiveTiles(imagery, r);
    log.length = 0;
    const rec = recordingSink();
    await exportLabels(imagery, r.store, r.classes, rec.sink, r.base);
    const out = await (await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer)).getImage();
    const [px] = (await out.readRasters()) as unknown as Uint8Array[];
    let bad = 0;
    for (const w of tileWindows(1000, 700)) {
      const t = want.get(`${w.x0},${w.y0}`)!;
      for (let i = 0; i < t.length; i++) if (px![(w.y0 + Math.floor(i / w.width)) * 1000 + w.x0 + (i % w.width)] !== t[i]) bad++;
    }
    expect(bad).toBe(0);
    // the edits are in the file, and the mask is masked by imagery nodata
    expect(px![2 * 1000 + 300]).toBe(3);
    expect(px![300 * 1000 + 600]).toBe(0);
    expect(px![110 * 1000 + 310]).toBe(maskValue(310, 110) && 0);
    expect(px![10]).toBe(maskValue(10, 0));
    const read = new Set(log.map((e) => e.slice(2)));
    for (const k of r.store.tiles.keys()) expect(read.has(k), k).toBe(false);
    // every other window the mask labels is read: its file window once, and its imagery window once
    const others = [...r.base.windows].filter((k) => !r.store.tiles.has(k)).sort();
    expect(log.filter((e) => e.startsWith("f")).map((e) => e.slice(2)).sort()).toEqual(others);
    expect(log.filter((e) => e.startsWith("i")).map((e) => e.slice(2)).sort()).toEqual(others);
  });
});

describe("the mask file gone (criterion 12, an export)", () => {
  it("an export whose mask read rejects with NotReadableError fails with the message; the store and classes are unchanged", { timeout: 60_000 }, async () => {
    const { imagery, r } = await setup();
    const keys = [...r.store.tiles.keys()], bytes = [...r.store.tiles.values()].map((t) => t.slice()), classes = structuredClone(r.classes);
    r.base.file.read = async () => { throw new DOMException("changed", "NotReadableError"); };
    const rec = recordingSink();
    const err = await exportLabels(imagery, r.store, r.classes, rec.sink, r.base).then(() => null, (e: unknown) => e);
    expect(readErrorMessage(err)).toBe("The label mask can't be read any more. Import it again.");
    expect(rec.closed).toBe(false);
    expect([...r.store.tiles.keys()]).toEqual(keys);
    [...r.store.tiles.values()].forEach((t, i) => expect(Buffer.from(t).equals(Buffer.from(bytes[i]!))).toBe(true));
    expect(r.classes).toEqual(classes);
  });
});
