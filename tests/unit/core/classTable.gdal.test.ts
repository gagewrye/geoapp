import { describe, expect, it } from "vitest";
import { paletteColour, type LabelClass } from "../../../src/core/classes";
import { decodeClasses, encodeClasses } from "../../../src/core/classTable";
import { GDAL_FIXTURE, GDAL_TABLE, gdalEscape, innerOf } from "../helpers/gdalMetadata";

// Spec 051 criteria 1-4: decodeClasses reads GDAL's double-escaped items as well as the app's.

const inner = innerOf(GDAL_FIXTURE);

describe("GDAL-written class tables (spec 051)", () => {
  it("decodes the fixture's GDAL form to its table exactly (criterion 1)", () => {
    expect(decodeClasses(inner)).toEqual(GDAL_TABLE);
  });

  it("decodes the app's form and GDAL's form of the same JSON alike, for hostile names (criterion 2)", () => {
    const names = ["</Item></GDALMetadata>", "]]>", "&amp; literal", "&#38;", "back\\slash", "\"quoted\" 'single'", "tab\there",
      "Mangrove \u{1F30A} wave", "line sep", "del\u007f", "nul\u0000x", "Ünïcödé 日本語", "é (NFC)", "é (NFD)", "Mangrove & <salt>"];
    for (const name of names) {
      const classes: LabelClass[] = [{ name, colour: paletteColour(0) }, { name: "other", colour: paletteColour(1) }];
      const app = innerOf(encodeClasses(classes));
      const json = JSON.stringify(classes.map((c, i) => ({ value: i + 1, ...c })));
      const want = classes.map((c, i) => ({ value: i + 1, name: c.name, colour: c.colour }));
      expect(decodeClasses(app), name).toEqual(want);
      expect(decodeClasses(gdalEscape(json)), name).toEqual(want);
    }
  });

  it("leaves encodeClasses' bytes and single-pass decoding unchanged (criterion 3)", () => {
    const classes: LabelClass[] = [{ name: "A & <B> \"it's\" é", colour: "#1f77b4" }];
    expect(encodeClasses(classes)).toBe('<GDALMetadata><Item name="GEOAPP_CLASSES">[{&quot;value&quot;:1,&quot;name&quot;:&quot;A &amp; &lt;B&gt; \\&quot;it&apos;s\\&quot; \\u00e9&quot;,&quot;colour&quot;:&quot;#1f77b4&quot;}]</Item></GDALMetadata>');
    expect(decodeClasses("[&quot;&amp;lt;&quot;, &quot;&apos;&quot;]")).toEqual(["&lt;", "'"]);
    expect(decodeClasses("[1, 2]")).toEqual([1, 2]);
  });

  it("still throws on bad JSON, a cut GDAL item and three levels of escaping (criterion 4)", () => {
    expect(() => decodeClasses("[{")).toThrow();
    expect(() => decodeClasses(inner.slice(0, inner.indexOf("&amp;quot;") + "&amp;quot;".length))).toThrow();
    expect(() => decodeClasses(inner.replaceAll("&amp;", "&amp;amp;"))).toThrow();
  });
});
