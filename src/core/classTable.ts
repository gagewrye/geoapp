import { checkName, MAX_CLASSES, paletteColour, type LabelClass } from "./classes";

/** The GDAL_METADATA dataset item holding a label file's class table (ADR 0013). */
export const CLASS_ITEM = "GEOAPP_CLASSES";

/** One row of a class table: a source pixel value 0..255, its name and optional "#rrggbb" colour. */
export type ClassEntry = { value: number; name: string; colour?: string };

/** A bad class table; `field` names the first bad field, e.g. "[2].value". */
export class ClassTableError extends Error {
  constructor(readonly field: string, why: string) {
    super(`Invalid class table: ${field} ${why}`);
  }
}

const COLOUR = /^#[0-9a-f]{6}$/i;

/** Validates a class table (spec 003's name rule, 1..255 entries, unique values, none equal to nodata). */
export function parseClasses(json: unknown, nodata: number | null): ClassEntry[] {
  if (!Array.isArray(json)) throw new ClassTableError("table", "must be an array");
  if (json.length < 1 || json.length > MAX_CLASSES) throw new ClassTableError("entries", `must be 1..${MAX_CLASSES}, got ${json.length}`);
  const out: ClassEntry[] = [];
  const values = new Set<number>();
  json.forEach((e: unknown, i) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) throw new ClassTableError(`[${i}]`, "must be an object");
    const { value, name, colour } = e as Record<string, unknown>;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) throw new ClassTableError(`[${i}].value`, "must be an integer 0..255");
    if (values.has(value)) throw new ClassTableError(`[${i}].value`, `duplicates ${value}`);
    if (value === nodata) throw new ClassTableError(`[${i}].value`, `is the file's nodata ${nodata}`);
    const n = typeof name === "string" ? checkName(out, -1, name) : null;
    if (n === null) throw new ClassTableError(`[${i}].name`, "must be a unique, non-empty string");
    if (colour !== undefined && (typeof colour !== "string" || !COLOUR.test(colour))) throw new ClassTableError(`[${i}].colour`, 'must be "#rrggbb"');
    values.add(value);
    out.push(colour === undefined ? { value, name: n } : { value, name: n, colour: colour.toLowerCase() });
  });
  return out;
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

/** Parses an item's raw inner text (geotiff.js doesn't unescape it); throws on bad JSON. */
export function decodeClasses(inner: string): unknown {
  // one pass, so "&amp;lt;" becomes "&lt;", not "<"
  return JSON.parse(inner.replace(/&(amp|lt|gt|quot|apos);/g, (m) => UNXML[m]!));
}
