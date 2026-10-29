import type { Model } from "./types";
import { validate } from "./validate";

export function serializeModel(model: Model): string {
  return JSON.stringify(model);
}

/** Parse and validate model JSON against a raster's band count. */
export function parseModel(text: string, bandCount: number): Model {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Model file is not valid JSON");
  }
  validate(value, bandCount);
  return value;
}
