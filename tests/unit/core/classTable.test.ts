import { describe, expect, it } from "vitest";
import { PALETTE, type LabelClass } from "../../../src/core/classes";
import { applyClassMap, classesFromValues, decodeClasses, encodeClasses, importEntries, mergeClasses, readClassTable } from "../../../src/core/classTable";

// Spec 047 criteria 1-3 (readClassTable replaced spec 004's parseClasses), spec 004 criteria 4 (classesFromValues), 6 (mergeClasses) and 9 (encodeClasses / decodeClasses).

const fields = (json: unknown, nodata: number | null = 255) => readClassTable(json, nodata).skipped.map((s) => s.field);
const W = "must be a unique, non-empty string";

describe("readClassTable (spec 047 criterion 1)", () => {
  it("a valid table gives every entry, trimming names, lowercasing colours, keeping order, and no skips", () => {
    const t = readClassTable([{ value: 3, name: " Water ", colour: "#00AAFF" }, { value: 0, name: "Land" }, { value: 254, name: "x", extra: 1 }], 255);
    expect(t).toEqual({ entries: [{ value: 3, name: "Water", colour: "#00aaff" }, { value: 0, name: "Land" }, { value: 254, name: "x" }], skipped: [] });
    expect(readClassTable(Array.from({ length: 255 }, (_, i) => ({ value: i + 1, name: `c${i}` })), 0).entries).toHaveLength(255);
    expect(readClassTable([{ value: 255, name: "a" }], null).entries).toEqual([{ value: 255, name: "a" }]);
  });

  it("a non-array and [] give no entries and one skip", () => {
    expect(readClassTable({ value: 1, name: "a" }, 255)).toEqual({ entries: [], skipped: [{ field: "table", why: "must be an array" }] });
    expect(readClassTable("[]", 255)).toEqual({ entries: [], skipped: [{ field: "table", why: "must be an array" }] });
    expect(readClassTable([], 255)).toEqual({ entries: [], skipped: [{ field: "table", why: "is empty" }] });
  });

  it("keeps only the valid entries, the bad-colour one without its colour, and names each skip in entry order", () => {
    const t = readClassTable([
      { value: 1, name: "One" }, 7, { value: 300, name: "Big" }, { value: 1, name: "Again" }, { value: 2, name: "One" },
      { value: 4, name: "  " }, { value: 255, name: "Nodata" }, { value: 5, name: "Red", colour: "red" }, { value: 6, name: "Six", colour: "#ABCDEF" },
    ], 255);
    expect(t.entries).toEqual([{ value: 1, name: "One" }, { value: 5, name: "Red" }, { value: 6, name: "Six", colour: "#abcdef" }]);
    expect(t.skipped).toEqual([
      { field: "[1]", why: "must be an object" }, { field: "[2].value", why: "must be an integer 0..255" }, { field: "[3].value", why: "duplicates 1" },
      { field: "[4].name", why: W }, { field: "[5].name", why: W }, { field: "[6].value", why: "is the file's nodata 255" }, { field: "[7].colour", why: 'must be "#rrggbb"' },
    ]);
  });

  it("skips a value that isn't an integer 0..255, a missing or non-string name, and every bad colour form", () => {
    for (const value of [1.5, "3", null, -1, 256, NaN, undefined]) expect(fields([{ value: 1, name: "a" }, { value, name: "b" }])).toEqual(["[1].value"]);
    expect(fields([{ value: 0, name: "a" }], 0)).toEqual(["[0].value"]);
    expect(fields([{ value: 1, name: 5 }])).toEqual(["[0].name"]);
    expect(fields([{ value: 1 }])).toEqual(["[0].name"]);
    expect(fields([null])).toEqual(["[0]"]);
    for (const colour of ["red", "#fff", "#12345g", "#1234567", 0x123456, "", null]) {
      expect(readClassTable([{ value: 1, name: "a", colour }], null)).toEqual({ entries: [{ value: 1, name: "a" }], skipped: [{ field: "[0].colour", why: 'must be "#rrggbb"' }] });
    }
  });

  it("never throws", () => {
    for (const json of [undefined, null, 3, "x", [[]], [{}], [Symbol.for("x")]]) expect(() => readClassTable(json, 0)).not.toThrow();
  });
});

describe("importEntries (spec 047 criterion 2)", () => {
  const seen = new Uint8Array(256);
  for (const v of [0, 3, 7]) seen[v] = 1;

  it("gives the table, then Class v for seen values it lacks, ascending, nodata skipped", () => {
    expect(importEntries([{ value: 3, name: "Water" }], seen, 255).map((e) => e.name)).toEqual(["Water", "Class 0", "Class 7"]);
    expect(importEntries([{ value: 3, name: "Water" }], seen, 0).map((e) => e.name)).toEqual(["Water", "Class 7"]);
    expect(importEntries([{ value: 3, name: "Water" }], seen, 255)).toEqual([{ value: 3, name: "Water" }, { value: 0, name: "Class 0" }, { value: 7, name: "Class 7" }]);
  });

  it("with an empty table equals classesFromValues", () => {
    for (const nd of [255, 0, null]) expect(importEntries([], seen, nd)).toEqual(classesFromValues(seen, nd));
  });
});

describe("applyClassMap (spec 047 criterion 3)", () => {
  const A: LabelClass = { name: "A", colour: "#111111" }, B: LabelClass = { name: "B", colour: "#222222" }, C: LabelClass = { name: "C", colour: "#333333" };
  const lut = new Uint8Array(256);
  lut[3] = 1; lut[5] = 2; lut[7] = 3;

  it("renames and recolours by value through the lut, skipping in entry order", () => {
    const classes = [A, B, C], before = structuredClone(classes);
    const r = applyClassMap(classes, lut, [{ value: 5, name: "Mangrove", colour: "#00ff00" }, { value: 0, name: "X" }, { value: 7, name: "A" }, { value: 3, name: "Q" }, { value: 3, name: "R" }, { value: 9, name: "Z" }]);
    expect(r.classes).toEqual([{ name: "Q", colour: "#111111" }, { name: "Mangrove", colour: "#00ff00" }, C]);
    expect(r.applied).toBe(2);
    expect(r.skipped).toEqual([
      { field: "[1].value", why: "has no class in these labels" }, { field: "[2].name", why: W },
      { field: "[4].value", why: "targets a class an earlier entry changed" }, { field: "[5].value", why: "has no class in these labels" },
    ]);
    expect(classes).toEqual(before);
  });

  it("skips non-objects and bad values; a bad colour keeps the class's colour; a non-array matches nothing", () => {
    const r = applyClassMap([A, B, C], lut, [null, { value: 3.5, name: "x" }, { value: 256, name: "x" }, { value: 3, name: " Sea ", colour: "blue" }, { value: 7, name: "Sea" }]);
    expect(r.classes).toEqual([{ name: "Sea", colour: "#111111" }, B, C]);
    expect(r.applied).toBe(1);
    expect(r.skipped.map((s) => s.field)).toEqual(["[0]", "[1].value", "[2].value", "[3].colour", "[4].name"]);
    expect(r.skipped.slice(0, 2).map((s) => s.why)).toEqual(["must be an object", "must be an integer 0..255"]);
    expect(applyClassMap([A], lut, { value: 3, name: "x" })).toEqual({ classes: [A], applied: 0, skipped: [{ field: "table", why: "must be an array" }] });
    expect(applyClassMap([A], lut, [])).toEqual({ classes: [A], applied: 0, skipped: [] });
  });

  it("a class may keep its own name, and swaps check against the list as it stands", () => {
    expect(applyClassMap([A, B, C], lut, [{ value: 3, name: "A", colour: "#abcdef" }]).classes[0]).toEqual({ name: "A", colour: "#abcdef" });
    const r = applyClassMap([A, B, C], lut, [{ value: 3, name: "B" }, { value: 5, name: "A" }]);
    expect(r.skipped.map((s) => s.field)).toEqual(["[0].name", "[1].name"]); // B and A are both still taken
    expect(r.classes.map((c) => c.name)).toEqual(["A", "B", "C"]);
  });
});

describe("classesFromValues (criterion 4)", () => {
  it("lists present values ascending as Class v, skipping nodata", () => {
    const seen = new Uint8Array(256);
    for (const v of [7, 0, 3, 255]) seen[v] = 1;
    expect(classesFromValues(seen, 255)).toEqual([{ value: 0, name: "Class 0" }, { value: 3, name: "Class 3" }, { value: 7, name: "Class 7" }]);
    expect(classesFromValues(seen, null).map((e) => e.name)).toEqual(["Class 0", "Class 3", "Class 7", "Class 255"]);
    expect(classesFromValues(new Uint8Array(256), null)).toEqual([]);
  });
});

describe("mergeClasses (criterion 6)", () => {
  const A: LabelClass = { name: "A", colour: "#111111" }, B: LabelClass = { name: "B", colour: "#222222" };

  it("with an empty list returns the incoming names, values 1..n and palette colours by position where none is given", () => {
    const r = mergeClasses([], [{ name: "x" }, { name: "y", colour: "#abcdef" }, { name: "z" }]);
    expect(r).toEqual({ list: [{ name: "x", colour: PALETTE[0] }, { name: "y", colour: "#abcdef" }, { name: "z", colour: PALETTE[2] }], values: [1, 2, 3] });
  });

  it("appends only new names, in order; existing classes keep their colours", () => {
    const r = mergeClasses([A, B], [{ name: "B", colour: "#999999" }, { name: "C" }]);
    expect(r).toEqual({ list: [A, B, { name: "C", colour: PALETTE[2] }], values: [2, 3] });
    // names match exactly, and a repeated incoming name maps to the same class
    const s = mergeClasses([A], [{ name: "a" }, { name: "a" }, { name: "A" }]);
    expect(s).toEqual({ list: [A, { name: "a", colour: PALETTE[1] }], values: [2, 2, 1] });
  });

  it("does not change the list it is given", () => {
    const list = [A, B];
    mergeClasses(list, [{ name: "C" }]);
    expect(list).toEqual([A, B]);
  });

  it("gives \"too many\" past 255 classes", () => {
    const list = Array.from({ length: 254 }, (_, i) => ({ name: `c${i}`, colour: "#000000" }));
    expect(mergeClasses(list, [{ name: "n1" }, { name: "n2" }])).toBe("too many");
    expect(mergeClasses(list, [{ name: "n1" }, { name: "c3" }])).not.toBe("too many");
  });
});

describe("encodeClasses / decodeClasses (criterion 9)", () => {
  const classes: LabelClass[] = [
    { name: "Mangrove & <salt>", colour: "#1f77b4" }, { name: `quote " and ' too`, colour: "#ff7f0e" },
    { name: "Forêt ümlaut 森林 🌳", colour: "#2ca02c" }, { name: "&amp; literally", colour: "#d62728" },
  ];

  it("wraps an XML-escaped, ASCII-only JSON ClassEntry[] (value = index + 1) in one GDAL_METADATA item", () => {
    const xml = encodeClasses(classes);
    expect(xml.startsWith('<GDALMetadata><Item name="GEOAPP_CLASSES">')).toBe(true);
    expect(xml.endsWith("</Item></GDALMetadata>")).toBe(true);
    // the TIFF ASCII tag holds 7-bit text only
    expect([...xml].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
    const inner = xml.slice('<GDALMetadata><Item name="GEOAPP_CLASSES">'.length, -"</Item></GDALMetadata>".length);
    expect(inner).not.toMatch(/[<>"']/);
    expect(decodeClasses(inner)).toEqual(classes.map((c, i) => ({ value: i + 1, name: c.name, colour: c.colour })));
  });

  it("decodeClasses throws on bad JSON", () => {
    expect(() => decodeClasses("[{")).toThrow();
    // one pass: an escaped "&lt;" stays "&lt;"
    expect(decodeClasses("[&quot;&amp;lt;&quot;, &quot;&apos;&quot;]")).toEqual(["&lt;", "'"]);
  });
});
