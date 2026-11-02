import type { ClassEntry } from "../../../src/core/classTable";

/** Spec 051's fixture: GDAL's GDAL_METADATA bytes for a Python json.dumps class table. */
export const GDAL_FIXTURE = `<GDALMetadata>
  <Item name="GEOAPP_CLASSES">[{&amp;quot;value&amp;quot;: 1, &amp;quot;name&amp;quot;: &amp;quot;mangrove&amp;quot;, &amp;quot;colour&amp;quot;: &amp;quot;#1f77b4&amp;quot;}, {&amp;quot;value&amp;quot;: 2, &amp;quot;name&amp;quot;: &amp;quot;A &amp;amp; &amp;lt;B&amp;gt; it's&amp;quot;}]</Item>
</GDALMetadata>
`;
/** The fixture's table. */
export const GDAL_TABLE: ClassEntry[] = [{ value: 1, name: "mangrove", colour: "#1f77b4" }, { value: 2, name: "A & <B> it's" }];

/** The text between an Item's start and end tags. */
export const innerOf = (text: string) => text.slice(text.indexOf(">", text.indexOf("<Item")) + 1, text.lastIndexOf("</Item>"));

/** GDAL's form of an item's JSON: CPLES_XML (`& < > "`) then CPLES_XML_BUT_QUOTES (`& < >`). */
export function gdalEscape(json: string): string {
  const once = json.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return once.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
}
