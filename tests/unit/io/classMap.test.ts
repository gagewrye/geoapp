import { describe, expect, it } from "vitest";
import type { LabelClass } from "../../../src/core/classes";
import { applyClassMap } from "../../../src/core/classTable";
import type { Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import { importLabels, importTable, type SeedOutcome } from "../../../src/io/seeding";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Spec 047: Apply class map changes a merged class once and skips bad entries without throwing;
// an import's 255-class limit is decided after the pass.

const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };
const G: Grid = { width: 300, height: 200, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] }; // partial edge tiles: 44 x 200
const img = () => fakeSource({ ...G, bandCount: 1, nodata: null, float: false }, () => 9);
const file = (f: (c: number, r: number) => number, nodata: number | null, classItem: string | null) => {
  const l = fakeLabelSource(G, f, nodata);
  return { ...l, source: { ...l.source, classItem } as LabelSource };
};
const lutOf = (pairs: [number, number][]) => { const l = new Uint8Array(256); for (const [v, k] of pairs) l[v] = k; return l; };

describe("applyClassMap edges", () => {
  it("a single class reached by two raw values is changed once; the second entry is skipped", () => {
    const one: LabelClass[] = [{ name: "Class 2", colour: "#123456" }];
    const r = applyClassMap(one, lutOf([[1, 1], [2, 1]]), [{ value: 2, name: "Sea", colour: "#ABCDEF" }, { value: 1, name: "Land" }]);
    expect(r.classes).toEqual([{ name: "Sea", colour: "#abcdef" }]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toEqual([{ field: "[1].value", why: "targets a class an earlier entry changed" }]);
  });

  it("skips entries with no or a non-string name, a string value, and never throws on odd JSON", () => {
    const lut = lutOf([[1, 1]]), A: LabelClass[] = [{ name: "A", colour: "#111111" }];
    const r = applyClassMap(A, lut, [{ value: 1 }, { value: 1, name: 7 }, { value: "1", name: "x" }, { value: 1, name: "  " }]);
    expect(r.skipped.map((s) => s.field)).toEqual(["[0].name", "[1].name", "[2].value", "[3].name"]);
    expect(r.applied).toBe(0);
    for (const j of [null, 3, "x", {}, [[]], [undefined], [{ value: NaN, name: "n" }]]) expect(() => applyClassMap(A, lut, j)).not.toThrow();
  });

});

describe("import with a lenient table, edges", () => {
  it("255 classes is the limit: a 255-entry table plus an unlisted value is \"too many\" after the pass, not before", async () => {
    const table255 = JSON.stringify(Array.from({ length: 255 }, (_, i) => ({ value: i + 1, name: `c${i + 1}` })));
    const withZero = file((c) => (c < 10 ? 0 : 1 + (c % 255)), null, table255);
    expect(await importLabels(img().source, withZero.source, importTable(withZero.source).table)).toBe("too many");
    expect(withZero.reads.length).toBeGreaterThan(0); // decided after the pass
    const without = file((c) => 1 + (c % 255), null, table255);
    expect(ok(await importLabels(img().source, without.source, importTable(without.source).table)).classes).toHaveLength(255);
  });

});
