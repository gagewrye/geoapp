# 051: Import labels reads class tables written by GDAL and rasterio

**Status:** Approved (Gage waived review, 2026-11-02). **ADRs:** none (no dependency; the file format of ADR 0013 is unchanged). **Amends:** spec 004's `decodeClasses` line in Interfaces. Checked against GDAL master (`frmts/gtiff/gtiffdataset_write.cpp`, `gtiffdataset_read.cpp`, `port/cpl_minixml.cpp`, `port/cpl_string.cpp`, 2026-11-02) and geotiff 3.0.5 (`dist-module/geotiffimage.js` `getGDALMetadata`, `imagefiledirectory.js`).

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): unit `core/classTable.gdal.tester`, and `io/seedTable.gdal.tester`'s empty-table case (renamed `io/seedTable.gdal.test.ts`, three cases kept).

**Goal:** Import labels takes the names and colours from a `GEOAPP_CLASSES` item written by GDAL or rasterio, as it does from an app-written one.

## Open question (does not block this spec)
1. **GDAL reading the app's files.** GDAL and rasterio misread app-written tables when a class name contains `&`: GDAL's second unescape stops at the bare `&` and cuts off the rest of the value, so `json.loads` fails (for example on spec 004's `Mangrove & <salt>`). Writing in GDAL's double-escaped form would fix that, and this spec's reader already accepts that form. It changes the bytes ADR 0013 describes, so it needs Gage. *Recommended:* a follow-up spec plus an ADR amending 0013.

## Why the escaping doubles (GDAL source)
- **Write:** `AppendMetadataItem` escapes the value with `CPLEscapeString(value, CPLES_XML)`, which escapes `& < > "` but not `'`. It stores the result as a text node. `CPLSerializeXMLTree` then escapes the text node again with `CPLES_XML_BUT_QUOTES` (`& < >`). The source comments call the first escape redundant and say it is kept for backward compatibility. So `"` becomes `&quot;` and then `&amp;quot;`.
- **Read:** the XML parser unescapes once (`ReadToken`). The Item loop then runs `CPLUnescapeString(value, CPLES_XML)` a second time (again, per the comment, "keep it for backward compatibility"). This is why GDAL and rasterio's `tags()` return clean JSON.
- **The app:** geotiff.js returns the item's raw inner text, decoded as UTF-8 and not unescaped. `decodeClasses` unescapes once and gets `[{&quot;value&quot;...`, which isn't JSON, so the import names every value "Class v" (spec 047).

## Decided
1. **Reader: parse once, else twice.** `decodeClasses` unescapes once and parses the result. If `JSON.parse` throws, it unescapes that result once more and parses again. It throws only if both attempts fail. This rule can't misread either form:
   - App-written text (escaped once) parses after the first pass, exactly as today. The second pass never runs, so names such as `&amp; literal` and `&#38;` still round-trip as written.
   - GDAL-written text, after one pass, holds `&quot;` wherever the JSON holds `"`. JSON whose strings were escaped therefore can't parse after one pass. JSON with no strings contains no `& < > "` at all, and both passes give the same text.
   - A file the app wrote and GDAL later rewrote (for example with `update_tags` on other keys) is in GDAL's form, so it reads too.
2. **Writer unchanged** (see the open question). Files the app wrote before or after this spec import as before.
3. **Same entity set in both passes:** `&amp; &lt; &gt; &quot; &apos;`. GDAL's writer only emits these, plus `&#xFEFF;` for a UTF-8 BOM, which is out of scope.
4. **Only `core/` changes.** `io/labelFile.ts` and `io/seeding.ts` (`importTable`) are unchanged, and text that is bad after both passes still gives spec 047's skip `JSON is not valid JSON`.

**Out of scope:** changing the writer; numeric character references; per-band or non-default-domain items; any other GDAL metadata item.

## Interfaces (`core/classTable.ts`)
```ts
decodeClasses(inner: string): unknown // one XML unescape, then JSON.parse; if that throws, a second unescape of that text, then JSON.parse; throws if both fail
```
`encodeClasses` and every other signature are unchanged.

## Fixture (GDAL's bytes for a Python `json.dumps` table, one line in the file)
```
<GDALMetadata>
  <Item name="GEOAPP_CLASSES">[{&amp;quot;value&amp;quot;: 1, &amp;quot;name&amp;quot;: &amp;quot;mangrove&amp;quot;, &amp;quot;colour&amp;quot;: &amp;quot;#1f77b4&amp;quot;}, {&amp;quot;value&amp;quot;: 2, &amp;quot;name&amp;quot;: &amp;quot;A &amp;amp; &amp;lt;B&amp;gt; it's&amp;quot;}]</Item>
</GDALMetadata>
```
Its table is [{1, "mangrove", "#1f77b4"}, {2, "A & <B> it's"}]. Tests build files in memory with the existing `writeTiff` helper (`tests/unit/helpers/labelFiles.ts`), passing this text as `metadata`. The real `pseudo_labels/*.tif` files are not used.

## Acceptance criteria
1. **Unit, GDAL form:** `decodeClasses` of the fixture's inner text returns the fixture's table exactly.
2. **Unit, both forms agree:** for every name in `classTable.tester.test.ts`'s hostile list (`</Item></GDALMetadata>`, `]]>`, `&amp; literal`, `&#38;`, quotes, backslash, tab, non-ASCII), plus `Mangrove & <salt>`, the inner text of `encodeClasses` and the same JSON in GDAL's form decode to the same entries. GDAL's form is built by a test helper that escapes `& < > "` and then `& < >`.
3. **Unit, app form unchanged:** `encodeClasses` output is byte-equal to its output before this spec. The existing tests of `decodeClasses`, including `"[&quot;&amp;lt;&quot;, &quot;&apos;&quot;]"` giving `["&lt;", "'"]`, pass unchanged.
4. **Unit, still refused:** `decodeClasses` throws on `[{`, on the fixture's inner text cut after its first `&amp;quot;`, and on the fixture's inner text with every `&amp;` replaced by `&amp;amp;` (three levels of escaping).
5. **Unit, io (fake imagery and a label file written in memory, values 1 and 2, nodata 0):** after `openLabelTiff`, `importTable` of the fixture file gives the fixture's table and no skips. `importLabels` gives the same classes (names, colours, order), `count` and preview as the same pixels written with `encodeClasses([{ name: "mangrove", colour: "#1f77b4" }, { name: "A & <B> it's", colour: paletteColour(1) }])`. Class 2 has no colour in the fixture, so it gets the palette colour for its position.
6. `npm run check` passes. Spec 004 criteria 9 and 11 and spec 047 criteria 1 and 4 pass. Spec 004's `decodeClasses` interface line is updated in the same change.
