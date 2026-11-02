import { describe, expect, it } from "vitest";
import { writeTiff } from "../../../src/io/tiffWriter";
import { fromArrayBuffer } from "geotiff";
import { paletteColour, type LabelClass } from "../../../src/core/classes";
import { CLASS_ITEM, decodeClasses, encodeClasses, mergeClasses, readClassTable } from "../../../src/core/classTable";
import { recordingSink } from "../helpers/sources";

// Tester edge cases for spec 004's class tables: the name rule after trimming, field names, the
// 255-class boundary, exact matching, and encode/decode of hostile and non-ASCII names.

/** The first skip's field, or null when nothing was skipped. */
const field = (json: unknown, nodata: number | null): string | null => readClassTable(json, nodata).skipped[0]?.field ?? null;

describe("readClassTable edges (spec 004's parseClasses edges, moved by spec 047)", () => {
  it("trims names (spec 003's rule) and skips names that collide after trimming", () => {
    expect(readClassTable([{ value: 1, name: "  Water " }], null).entries).toEqual([{ value: 1, name: "Water" }]);
    expect(field([{ value: 1, name: "Water" }, { value: 2, name: " Water" }], null)).toBe("[1].name");
    expect(field([{ value: 1, name: "   " }], null)).toBe("[0].name");
  });

  it("skips NaN, Infinity, numeric strings, null entries and null colours, naming the field", () => {
    expect(field([{ value: 1, name: "a" }, { value: Infinity, name: "b" }], null)).toBe("[1].value");
    expect(field([{ value: "3", name: "a" }], null)).toBe("[0].value");
    expect(field([null], null)).toBe("[0]");
    expect(field([{ value: 1, name: "a", colour: null }], null)).toBe("[0].colour");
    expect(field([{ value: 1, name: "a", colour: "#12345" }], null)).toBe("[0].colour");
    expect(field([{ value: 1, name: "a", colour: "123456" }], null)).toBe("[0].colour");
    expect(field({ length: 1, 0: { value: 1, name: "a" } }, null)).toBe("table");
  });

  it("keeps 255 entries; with nodata 0 the 0 entry is skipped, and 256 entries are all kept (\"too many\" is the import's)", () => {
    const t = Array.from({ length: 255 }, (_, i) => ({ value: i, name: `n${i}` }));
    expect(readClassTable(t, null).entries).toHaveLength(255);
    expect(readClassTable(t, 255).entries).toHaveLength(255);
    expect(readClassTable(t, 0).entries).toHaveLength(254);
    expect(field(t, 0)).toBe("[0].value");
    expect(readClassTable(Array.from({ length: 256 }, (_, i) => ({ value: i, name: `n${i}` })), null).entries).toHaveLength(256);
  });
});

describe("mergeClasses edges", () => {
  const list = (n: number): LabelClass[] => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, colour: "#000000" }));

  it("reaches 255 exactly, and 255 classes take further names only when they all match", () => {
    const r = mergeClasses(list(253), [{ name: "x" }, { name: "y" }]);
    expect(r === "too many" ? r : r.values).toEqual([254, 255]);
    const m = mergeClasses(list(255), [{ name: "c254" }, { name: "c0" }]);
    expect(m === "too many" ? m : m.values).toEqual([255, 1]);
    expect(mergeClasses(list(255), [{ name: "c0" }, { name: "new" }])).toBe("too many");
  });

  it("matches names exactly (case and spaces count), keeps a matched class's colour, and leaves its input list unchanged", () => {
    const l: LabelClass[] = [{ name: "Water", colour: "#111111" }];
    const before = structuredClone(l);
    const r = mergeClasses(l, [{ name: "water" }, { name: "Water", colour: "#999999" }, { name: "Water " }]);
    if (r === "too many") throw new Error(r);
    expect(r.list).toEqual([{ name: "Water", colour: "#111111" }, { name: "water", colour: paletteColour(1) }, { name: "Water ", colour: paletteColour(2) }]);
    expect(r.values).toEqual([2, 1, 3]);
    expect(l).toEqual(before);
    r.list[0]!.colour = "#222222";
    expect(l[0]!.colour).toBe("#111111"); // a copy, not the caller's objects
  });

  it("incoming [] gives the list and no values", () => {
    expect(mergeClasses(list(2), [])).toEqual({ list: list(2), values: [] });
  });
});

describe("encodeClasses / decodeClasses with hostile names", () => {
  const names = ["</Item></GDALMetadata>", "]]>", "&amp; literal", "&#38;", "back\\slash", "\"quoted\" 'single'", "tab\there",
    "Mangrove \u{1F30A} wave", "line sep", "del\u007f", "nul\u0000x", "Ünïcödé 日本語", "é (NFC)", "é (NFD)"];
  const classes: LabelClass[] = names.map((name, i) => ({ name, colour: paletteColour(i) }));

  it("is 7-bit ASCII with no NUL, and round-trips every name and colour", () => {
    const text = encodeClasses(classes);
    expect([...text].every((ch) => ch.charCodeAt(0) > 0 && ch.charCodeAt(0) < 128)).toBe(true);
    const inner = text.slice(text.indexOf(">", text.indexOf("<Item")) + 1, text.lastIndexOf("</Item>"));
    expect(decodeClasses(inner)).toEqual(classes.map((c, i) => ({ value: i + 1, name: c.name, colour: c.colour })));
  });

  it("survives ADR 0001's writer and geotiff.js getGDALMetadata(), as the only dataset item", async () => {
    const rec = recordingSink();
    const geo = { GeoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 4326], ModelPixelScale: [0.01, 0.01, 0], ModelTiepoint: [0, 0, 0, 10, 50, 0] };
    await writeTiff(rec.sink, 300, 10, geo, async (w) => new Uint8Array(w.width * w.height), { nodata: "0", metadata: encodeClasses(classes) });
    const image = await (await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer)).getImage();
    const md = (await image.getGDALMetadata()) as Record<string, string>;
    expect(Object.keys(md)).toEqual([CLASS_ITEM]);
    expect(decodeClasses(md[CLASS_ITEM]!)).toEqual(classes.map((c, i) => ({ value: i + 1, name: c.name, colour: c.colour })));
  });
});
