import { describe, expect, it } from "vitest";
import { paletteColour, type LabelClass } from "../../../src/core/classes";
import { decodeClasses, encodeClasses } from "../../../src/core/classTable";
import { GDAL_FIXTURE, gdalEscape, innerOf } from "../helpers/gdalMetadata";

// Spec 051 tester edge cases: forms the implementer's tests don't reach.

/** XML-unescape once, as GDAL's parser does, to get the JSON GDAL would see from the app's inner text. */
const unxml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[m]!);

describe("decodeClasses edge cases (spec 051)", () => {
  it("reads string-less JSON and empty tables the same in both forms", () => {
    for (const json of ["[]", "[1, 2]", "{}", "[[], {}]", "null", "0"]) {
      expect(decodeClasses(json), json).toEqual(JSON.parse(json));
      expect(decodeClasses(gdalEscape(json)), json).toEqual(JSON.parse(json));
    }
  });

  it("reads a single-class GDAL table and a pretty-printed (indented) one", () => {
    const one = [{ value: 7, name: "car", colour: "#ffff00" }];
    expect(decodeClasses(gdalEscape(JSON.stringify(one)))).toEqual(one);
    const two = [{ value: 1, name: "a\"b", colour: "#000000" }, { value: 2, name: "<c>" }];
    expect(decodeClasses(gdalEscape(JSON.stringify(two, null, 2)))).toEqual(two);
  });

  it("keeps literal entity names (&quot; &apos; &lt; &amp;amp;) intact in GDAL's form", () => {
    for (const name of ["&quot;", "&apos;", "&lt;tag&gt;", "&amp;amp;", "&", "&&;", "a&quot;b\"c"]) {
      const json = JSON.stringify([{ value: 1, name }]);
      expect(decodeClasses(gdalEscape(json)), name).toEqual([{ value: 1, name }]);
    }
  });

  it("reads raw (not u-escaped) UTF-8 text in GDAL's form, as json.dumps(ensure_ascii=False) writes", () => {
    const t = [{ value: 1, name: "Mangue \u00e9 \u65e5\u672c \u{1F30A} & <x>" }];
    expect(decodeClasses(gdalEscape(JSON.stringify(t)))).toEqual(t);
  });

  it("reads an app file that GDAL later rewrote (update_tags), with the app's names", () => {
    const classes: LabelClass[] = [{ name: "Mangrove & <salt>", colour: paletteColour(0) }, { name: "&amp; literal", colour: paletteColour(1) }, { name: "it's \"q\"", colour: "#123456" }];
    const app = innerOf(encodeClasses(classes));
    const rewritten = gdalEscape(unxml(app));
    const want = classes.map((c, i) => ({ value: i + 1, ...c }));
    expect(decodeClasses(app)).toEqual(want);
    expect(decodeClasses(rewritten)).toEqual(want);
  });

  it("throws on empty and whitespace-only text, and on GDAL text cut mid-entity", () => {
    expect(() => decodeClasses("")).toThrow();
    expect(() => decodeClasses("  \n ")).toThrow();
    const inner = innerOf(GDAL_FIXTURE);
    expect(() => decodeClasses(inner.slice(0, inner.length - 3))).toThrow();
    expect(() => decodeClasses(inner.slice(0, inner.indexOf("&amp;amp;") + 4))).toThrow();
  });

  it("never applies a third pass: two-level text whose JSON names hold an entity keeps it", () => {
    // JSON name "&lt;" in GDAL form is &amp;amp;lt; ; a third pass would turn it into "<"
    expect(decodeClasses("[&amp;quot;&amp;amp;lt;&amp;quot;]")).toEqual(["&lt;"]);
  });
});
