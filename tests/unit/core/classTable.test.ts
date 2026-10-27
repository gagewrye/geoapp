import { describe, expect, it } from "vitest";
import { PALETTE, type LabelClass } from "../../../src/core/classes";
import { classesFromValues, ClassTableError, decodeClasses, encodeClasses, mergeClasses, parseClasses } from "../../../src/core/classTable";

// Spec 004 criteria 3, 4 (classesFromValues), 6 (mergeClasses) and 9 (encodeClasses / decodeClasses).

const field = (json: unknown, nodata: number | null = 255): string => {
  try {
    parseClasses(json, nodata);
  } catch (e) {
    expect(e).toBeInstanceOf(ClassTableError);
    return (e as ClassTableError).field;
  }
  throw new Error("parseClasses accepted it");
};

describe("parseClasses (criterion 3)", () => {
  it("accepts a valid table, trimming names, lowercasing colours, keeping order", () => {
    const t = parseClasses([{ value: 3, name: " Water ", colour: "#00AAFF" }, { value: 0, name: "Land" }, { value: 254, name: "x", extra: 1 }], 255);
    expect(t).toEqual([{ value: 3, name: "Water", colour: "#00aaff" }, { value: 0, name: "Land" }, { value: 254, name: "x" }]);
    expect(parseClasses(Array.from({ length: 255 }, (_, i) => ({ value: i + 1, name: `c${i}` })), 0)).toHaveLength(255);
    expect(parseClasses([{ value: 255, name: "a" }], null)).toEqual([{ value: 255, name: "a" }]);
  });

  it("rejects a non-array, and 0 or 256 entries", () => {
    expect(field({ value: 1, name: "a" })).toBe("table");
    expect(field("[]")).toBe("table");
    expect(field([])).toBe("entries");
    expect(field(Array.from({ length: 256 }, (_, i) => ({ value: i, name: `c${i}` })), null)).toBe("entries");
  });

  it("rejects a value that isn't an integer, is outside 0..255, is duplicated or equals nodata", () => {
    for (const value of [1.5, "3", null, -1, 256, NaN]) expect(field([{ value: 1, name: "a" }, { value, name: "b" }])).toBe("[1].value");
    expect(field([{ value: 4, name: "a" }, { value: 4, name: "b" }])).toBe("[1].value");
    expect(field([{ value: 255, name: "a" }], 255)).toBe("[0].value");
    expect(field([{ value: 0, name: "a" }], 0)).toBe("[0].value");
    expect(field([{ name: "a" }])).toBe("[0].value");
  });

  it("rejects a name that is empty, duplicated or not a string, and an entry that isn't an object", () => {
    expect(field([{ value: 1, name: "  " }])).toBe("[0].name");
    expect(field([{ value: 1, name: "a" }, { value: 2, name: " a" }])).toBe("[1].name");
    expect(field([{ value: 1, name: 5 }])).toBe("[0].name");
    expect(field([{ value: 1 }])).toBe("[0].name");
    expect(field([{ value: 1, name: "a" }, 7])).toBe("[1]");
    expect(field([null])).toBe("[0]");
  });

  it("rejects a colour that isn't #rrggbb", () => {
    for (const colour of ["red", "#fff", "#12345g", "#1234567", 0x123456, ""]) expect(field([{ value: 1, name: "a", colour }])).toBe("[0].colour");
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
