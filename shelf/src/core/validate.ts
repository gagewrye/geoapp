import type { Model } from "./types";

function fail(field: string, why: string): never {
  throw new Error(`Invalid model: ${field} ${why}`);
}

function numbers(v: unknown, field: string, len: number): number[] {
  if (!Array.isArray(v)) fail(field, "must be an array");
  if (v.length !== len) fail(field, `has length ${v.length}, expected ${len}`);
  v.forEach((x, i) => {
    if (typeof x !== "number" || !Number.isFinite(x)) fail(`${field}[${i}]`, "must be a finite number");
  });
  return v as number[];
}

/** Throws an Error naming the first bad field. */
export function validate(model: unknown, bandCount: number): asserts model is Model {
  if (typeof model !== "object" || model === null || Array.isArray(model)) fail("model", "must be an object");
  const m = model as Record<string, unknown>;
  if (m.version !== 1) fail("version", "must be 1");
  if (m.type !== "logreg") fail("type", 'must be "logreg"');

  const bands = m.bands;
  if (!Array.isArray(bands) || bands.length === 0) fail("bands", "must be a non-empty array");
  const seen = new Set<number>();
  bands.forEach((x, i) => {
    if (!Number.isInteger(x) || x < 1 || x > bandCount) fail(`bands[${i}]`, `must be an integer in 1..${bandCount}`);
    if (seen.has(x)) fail(`bands[${i}]`, `duplicates band ${x}`);
    seen.add(x);
  });
  const d = bands.length;

  const classes = m.classes;
  if (!Array.isArray(classes) || classes.length < 2 || classes.length > 255) fail("classes", "must have 2..255 entries");
  classes.forEach((c, i) => { if (typeof c !== "string") fail(`classes[${i}]`, "must be a string"); });
  const k = classes.length;

  numbers(m.mean, "mean", d);
  numbers(m.std, "std", d).forEach((s, i) => { if (s <= 0) fail(`std[${i}]`, "must be > 0"); });
  if (!Array.isArray(m.W)) fail("W", "must be an array");
  if (m.W.length !== k) fail("W", `has length ${m.W.length}, expected ${k} (classes)`);
  m.W.forEach((row, i) => numbers(row, `W[${i}]`, d));
  numbers(m.b, "b", k);
}
