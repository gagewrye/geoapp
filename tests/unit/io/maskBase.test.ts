import { describe, expect, it } from "vitest";
import type { LabelSource } from "../../../src/io/labelFile";
import { useCopy, type MaskBase } from "../../../src/io/maskBase";

// Spec 074 criterion 4 (ADR 0041): the base reads the app's copy once swapped, and only while it is still the base.
describe("useCopy", () => {
  const base = (file: unknown) => ({ file, lut: new Uint8Array(256), count: 1, windows: new Set<string>(), preview: {} }) as unknown as MaskBase;

  it("swaps the live base's file in place, and nothing once another base replaced it", () => {
    const user = { name: "user" } as unknown as LabelSource, copy = { name: "copy" } as unknown as LabelSource;
    const a = base(user);
    expect(useCopy(a, a, copy)).toBe(true);
    expect(a.file).toBe(copy);
    const b = base(user);
    expect(useCopy(b, a, copy)).toBe(false);
    expect(b.file).toBe(user);
    expect(useCopy(null, b, copy)).toBe(false);
    expect(b.file).toBe(user);
  });
});
