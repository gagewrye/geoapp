import { describe, expect, it } from "vitest";
import type { LabelClass } from "../../../src/core/classes";
import { applyClassMap, readClassTable } from "../../../src/core/classTable";
import type { Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import { importLabels, importTable, type SeedOutcome } from "../../../src/io/seeding";
import { classMapMessage, seedMessage } from "../../../src/ui/messages";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Spec 047, tester edge cases: empty and single-class labels, merged classes, a stale lut, the
// 255-class boundary before and after the pass, partial edge tiles, and the read windows' size.

const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };
const G: Grid = { width: 300, height: 200, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] }; // partial edge tiles: 44 x 200
const img = () => fakeSource({ ...G, bandCount: 1, nodata: null, float: false }, () => 9);
const file = (f: (c: number, r: number) => number, nodata: number | null, classItem: string | null) => {
  const l = fakeLabelSource(G, f, nodata);
  return { ...l, source: { ...l.source, classItem } as LabelSource };
};
const lutOf = (pairs: [number, number][]) => { const l = new Uint8Array(256); for (const [v, k] of pairs) l[v] = k; return l; };

describe("applyClassMap edges", () => {
  it("empty labels (no classes, lut all 0) match nothing and say so as an error", () => {
    const r = applyClassMap([], new Uint8Array(256), [{ value: 0, name: "x" }, { value: 255, name: "y" }]);
    expect(r).toEqual({ classes: [], applied: 0, skipped: [{ field: "[0].value", why: "has no class in these labels" }, { field: "[1].value", why: "has no class in these labels" }] });
    expect(classMapMessage(r.applied, r.skipped)).toEqual({ text: "Class map matched no class. Skipped: [0].value has no class in these labels (+1 more).", kind: "error" });
  });

  it("a single class reached by two raw values is changed once; the second entry is skipped", () => {
    const one: LabelClass[] = [{ name: "Class 2", colour: "#123456" }];
    const r = applyClassMap(one, lutOf([[1, 1], [2, 1]]), [{ value: 2, name: "Sea", colour: "#ABCDEF" }, { value: 1, name: "Land" }]);
    expect(r.classes).toEqual([{ name: "Sea", colour: "#abcdef" }]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toEqual([{ field: "[1].value", why: "targets a class an earlier entry changed" }]);
  });

  it("a lut reaching past the list is no class; neither the lut nor the list is mutated", () => {
    const list: LabelClass[] = [{ name: "A", colour: "#111111" }], lut = lutOf([[4, 1], [5, 9]]), copy = lut.slice();
    const r = applyClassMap(list, lut, [{ value: 5, name: "B" }, { value: 4, name: "C" }]);
    expect(r.skipped).toEqual([{ field: "[0].value", why: "has no class in these labels" }]);
    expect(r.classes).toEqual([{ name: "C", colour: "#111111" }]);
    expect(list).toEqual([{ name: "A", colour: "#111111" }]);
    expect(lut).toEqual(copy);
  });

  it("skips entries with no or a non-string name, a string value, and never throws on odd JSON", () => {
    const lut = lutOf([[1, 1]]), A: LabelClass[] = [{ name: "A", colour: "#111111" }];
    const r = applyClassMap(A, lut, [{ value: 1 }, { value: 1, name: 7 }, { value: "1", name: "x" }, { value: 1, name: "  " }]);
    expect(r.skipped.map((s) => s.field)).toEqual(["[0].name", "[1].name", "[2].value", "[3].name"]);
    expect(r.applied).toBe(0);
    for (const j of [null, 3, "x", {}, [[]], [undefined], [{ value: NaN, name: "n" }]]) expect(() => applyClassMap(A, lut, j)).not.toThrow();
  });

  it("applying the same map twice gives the same list (an entry may keep its class's own name)", () => {
    const list: LabelClass[] = [{ name: "A", colour: "#111111" }, { name: "B", colour: "#222222" }];
    const map = [{ value: 3, name: "Water", colour: "#0000ff" }, { value: 0, name: "Sand" }], lut = lutOf([[0, 1], [3, 2]]);
    const once = applyClassMap(list, lut, map), twice = applyClassMap(once.classes, lut, map);
    expect(twice).toEqual({ classes: once.classes, applied: 2, skipped: [] });
  });

  it("the message lists the skips after the applied count", () => {
    expect(classMapMessage(2, [])).toEqual({ text: "Class map applied to 2 classes.", kind: "info" });
    expect(classMapMessage(1, [{ field: "[3].colour", why: 'must be "#rrggbb"' }]).text).toBe('Class map applied to 1 classes. Skipped: [3].colour must be "#rrggbb".');
  });
});

describe("import with a lenient table, edges", () => {
  it("a single-class file with an empty table [] imports as Class v and names the skip", async () => {
    const f = file(() => 5, 0, "[]");
    const { table, skipped } = importTable(f.source);
    expect(skipped).toEqual([{ field: "table", why: "is empty" }]);
    const r = ok(await importLabels(img().source, f.source, table));
    expect(r.classes.map((c) => c.name)).toEqual(["Class 5"]);
    expect(r.base.count).toBe(G.width * G.height);
    expect(seedMessage(r, skipped)).toBe(`Seeded ${G.width * G.height} pixels in 1 classes. Ignored part of the file's class table: table is empty.`);
  });

  it("a table whose every entry is skipped, on a file of only nodata, is \"empty\"", async () => {
    const f = file(() => 0, 0, JSON.stringify([{ value: 0, name: "Nodata" }]));
    const { table, skipped } = importTable(f.source);
    expect([table, skipped.map((s) => s.field)]).toEqual([[], ["[0].value"]]);
    expect(await importLabels(img().source, f.source, table)).toBe("empty");
  });

  it("a table value absent from the file keeps its class, and Apply class map can rename it", async () => {
    const f = file((c) => (c < 150 ? 1 : 2), 0, JSON.stringify([{ value: 9, name: "Absent" }, { value: 1, name: "One" }]));
    const r = ok(await importLabels(img().source, f.source, importTable(f.source).table));
    expect(r.classes.map((c) => c.name)).toEqual(["Absent", "One", "Class 2"]);
    const a = applyClassMap(r.classes, r.base.lut, [{ value: 9, name: "Gone" }, { value: 2, name: "Two" }]);
    expect(a.classes.map((c) => c.name)).toEqual(["Gone", "One", "Two"]);
  });

  it("255 classes is the limit: a 255-entry table plus an unlisted value is \"too many\" after the pass, not before", async () => {
    const table255 = JSON.stringify(Array.from({ length: 255 }, (_, i) => ({ value: i + 1, name: `c${i + 1}` })));
    const withZero = file((c) => (c < 10 ? 0 : 1 + (c % 255)), null, table255);
    expect(await importLabels(img().source, withZero.source, importTable(withZero.source).table)).toBe("too many");
    expect(withZero.reads.length).toBeGreaterThan(0); // decided after the pass
    const without = file((c) => 1 + (c % 255), null, table255);
    expect(ok(await importLabels(img().source, without.source, importTable(without.source).table)).classes).toHaveLength(255);
  });

  it("a 256-entry table (no nodata) is kept by readClassTable and is \"too many\" before any read", async () => {
    const t = Array.from({ length: 256 }, (_, v) => ({ value: v, name: `c${v}` }));
    expect(readClassTable(t, null).entries).toHaveLength(256);
    const f = file(() => 1, null, JSON.stringify(t)), i = img();
    expect(await importLabels(i.source, f.source, importTable(f.source).table)).toBe("too many");
    expect([f.reads.length, i.reads.length]).toEqual([0, 0]);
  });

  it("no imagery read spans more than one 256-row band (ADR 0021), partial edge tiles included", async () => {
    const f = file((c, r) => ((c >> 4) + (r >> 4)) % 8 + 1, 0, "{not json");
    const i = fakeSource({ ...G, bandCount: 1, nodata: 0, float: false }, (_b, c) => (c < 20 ? 0 : 9)); // nodata, so masks are read
    ok(await importLabels(i.source, f.source, importTable(f.source).table));
    expect(i.reads.length).toBeGreaterThan(0);
    for (const w of i.reads) expect(w.height <= 256 && Math.floor(w.y0 / 256) === Math.floor((w.y0 + w.height - 1) / 256), `${w.x0},${w.y0} ${w.width}x${w.height}`).toBe(true);
    for (const w of f.reads) expect(w.height <= 256, `file ${w.x0},${w.y0} ${w.width}x${w.height}`).toBe(true);
  });
});
