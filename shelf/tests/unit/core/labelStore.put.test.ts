// Fragment of tests/unit/core/labelStore.put.test.ts (spec 013): its assertions on shelved functions, to merge back by hand.
import { describe, expect, it } from "vitest";
import { emptyStore, paintedClasses } from "../../../src/core/labelStore";

// The spec 003 review handoff: only values with a class count.

describe("paintedClasses", () => {
  it("counts the classes with labelled pixels, ignoring values with no class", () => {
    const store = emptyStore(256, 256);
    const t = new Uint8Array(65536);
    t[0] = 1; t[1] = 3; t[2] = 3; t[3] = 9;
    store.tiles.set("0,0", t);
    expect(paintedClasses(store, 3)).toBe(2);
    expect(paintedClasses(store, 9)).toBe(3);
    expect(paintedClasses(emptyStore(10, 10), 2)).toBe(0);
  });
});
