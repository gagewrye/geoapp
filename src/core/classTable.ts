import { checkName, MAX_CLASSES, paletteColour, type LabelClass } from "./classes";

/** The GDAL_METADATA dataset item holding a label file's class table (ADR 0013). */
export const CLASS_ITEM = "GEOAPP_CLASSES";

/** One row of a class table: a source pixel value 0..255, its name and optional "#rrggbb" colour. */
export type ClassEntry = { value: number; name: string; colour?: string };

/** Why part of a class table or class map was skipped; `field` is e.g. "JSON", "table", "[2].value" or "[2].colour". */
export type Skip = { field: string; why: string };

const COLOUR = /^#[0-9a-f]{6}$/i;
const NAME = "must be a unique, non-empty string", BYTE = "must be an integer 0..255", BAD_COLOUR = 'must be "#rrggbb"';
const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e);
const isByte = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255;
/** The lowercased colour; undefined when absent, null when present but not "#rrggbb". */
const colourOf = (c: unknown): string | undefined | null => (c === undefined ? undefined : typeof c === "string" && COLOUR.test(c) ? c.toLowerCase() : null);

/** A file's class table, read leniently (spec 047): bad entries are skipped and a bad colour dropped, never thrown. */
// Spec 003's name rule, unique values, none equal to nodata; a table that isn't a non-empty array gives no entries.
export function readClassTable(json: unknown, nodata: number | null): { entries: ClassEntry[]; skipped: Skip[] } {
  if (!Array.isArray(json)) return { entries: [], skipped: [{ field: "table", why: "must be an array" }] };
  if (!json.length) return { entries: [], skipped: [{ field: "table", why: "is empty" }] };
  const entries: ClassEntry[] = [], skipped: Skip[] = [];
  const values = new Set<number>();
  json.forEach((e: unknown, i) => {
    const skip = (f: string, why: string) => { skipped.push({ field: `[${i}]${f}`, why }); };
    if (!isEntry(e)) return skip("", "must be an object");
    const { value, name, colour } = e;
    if (!isByte(value)) return skip(".value", BYTE);
    if (values.has(value)) return skip(".value", `duplicates ${value}`);
    if (value === nodata) return skip(".value", `is the file's nodata ${nodata}`);
    const n = typeof name === "string" ? checkName(entries, -1, name) : null;
    if (n === null) return skip(".name", NAME);
    const c = colourOf(colour);
    if (c === null) skip(".colour", BAD_COLOUR);
    values.add(value);
    entries.push(c ? { value, name: n, colour: c } : { value, name: n });
  });
  return { entries, skipped };
}

/** The import's entries: the table, then "Class v" for seen values it lacks, ascending, nodata skipped. */
export function importEntries(table: ClassEntry[], seen: Uint8Array, nodata: number | null): ClassEntry[] {
  const listed = new Set(table.map((e) => e.value));
  return [...table, ...classesFromValues(seen, nodata).filter((e) => !listed.has(e.value))];
}

/** Renames and recolours the classes a class map's raw values reach through the import's lut (spec 047); input not mutated. */
// One change per class, in entry order, so a map can't rename a class twice; names follow spec 003's rule
// against the list as it stands.
export function applyClassMap(classes: LabelClass[], lut: Uint8Array, json: unknown): { classes: LabelClass[]; applied: number; skipped: Skip[] } {
  const out = classes.map((c) => ({ ...c }));
  if (!Array.isArray(json)) return { classes: out, applied: 0, skipped: [{ field: "table", why: "must be an array" }] };
  const changed = new Set<number>(), skipped: Skip[] = [];
  json.forEach((e: unknown, i) => {
    const skip = (f: string, why: string) => { skipped.push({ field: `[${i}]${f}`, why }); };
    if (!isEntry(e)) return skip("", "must be an object");
    const { value, name, colour } = e;
    if (!isByte(value)) return skip(".value", BYTE);
    const k = lut[value]! - 1;
    if (k < 0 || k >= out.length) return skip(".value", "has no class in these labels");
    if (changed.has(k)) return skip(".value", "targets a class an earlier entry changed");
    const n = typeof name === "string" ? checkName(out, k, name) : null;
    if (n === null) return skip(".name", NAME);
    const c = colourOf(colour);
    if (c === null) skip(".colour", BAD_COLOUR);
    changed.add(k);
    out[k] = { name: n, colour: c ?? out[k]!.colour };
  });
  return { classes: out, applied: changed.size, skipped };
}

/** "Class v" for every value seen (seen[v] = 1), ascending, nodata skipped. */
export function classesFromValues(seen: Uint8Array, nodata: number | null): ClassEntry[] {
  const out: ClassEntry[] = [];
  for (let v = 0; v < 256; v++) if (seen[v] && v !== nodata) out.push({ value: v, name: `Class ${v}` });
  return out;
}

/** The list, then incoming names not in it (exact match), in order; values[i] is incoming[i]'s label value. */
// Existing classes keep their place so Merge never relabels pixels already painted. Missing colours
// come from the palette by final position, as a new class would get. Label values are 8-bit with 0
// unlabelled, so over 255 classes gives "too many".
export function mergeClasses(list: LabelClass[], incoming: { name: string; colour?: string }[]): { list: LabelClass[]; values: number[] } | "too many" {
  const out = list.map((c) => ({ ...c }));
  const index = new Map(out.map((c, i) => [c.name, i]));
  const values: number[] = [];
  for (const { name, colour } of incoming) {
    let i = index.get(name);
    if (i === undefined) {
      i = out.length;
      if (i >= MAX_CLASSES) return "too many";
      out.push({ name, colour: colour ?? paletteColour(i) });
      index.set(name, i);
    }
    values.push(i + 1);
  }
  return { list: out, values };
}

const XML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const UNXML: Record<string, string> = Object.fromEntries(Object.entries(XML).map(([k, v]) => [v, k]));

/** The GDAL_METADATA text of a label export: every class, value = index + 1 (ADR 0013). */
export function encodeClasses(classes: LabelClass[]): string {
  const entries: ClassEntry[] = classes.map((c, i) => ({ value: i + 1, name: c.name, colour: c.colour }));
  // TIFF ASCII tags hold 7-bit text, so non-ASCII goes as JSON \u escapes
  const json = JSON.stringify(entries).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<GDALMetadata><Item name="${CLASS_ITEM}">${json.replace(/[&<>"']/g, (ch) => XML[ch]!)}</Item></GDALMetadata>`;
}

const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => UNXML[m]!);

/** Parses an item's raw inner text (geotiff.js doesn't unescape it), the app's or GDAL's form; throws on bad JSON. */
// The app escapes once, so one pass keeps "&amp;lt;" as "&lt;". GDAL escapes twice (spec 051); its text
// still holds &quot; after one pass wherever the JSON has a string, so it can't parse until a second pass.
export function decodeClasses(inner: string): unknown {
  const once = unescapeXml(inner);
  try {
    return JSON.parse(once);
  } catch {
    return JSON.parse(unescapeXml(once));
  }
}
