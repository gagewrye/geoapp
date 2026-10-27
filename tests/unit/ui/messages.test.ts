import { describe, expect, it } from "vitest";
import { MESSAGES, seedMessage } from "../../../src/ui/messages";

// Spec 004 criterion 16: ui maps "full" and "too many" to their messages; the rest of the Merge or Replace messages.

describe("seedMessage", () => {
  it("maps each outcome to the spec's message, and a stale run to none", () => {
    expect(seedMessage("full")).toBe("Label limit reached (256 tiles of 256 x 256 px). Nothing was seeded.");
    expect(seedMessage("too many")).toBe("Too many classes (max 255). Nothing was seeded.");
    expect(seedMessage("empty")).toBe("No labels to seed here.");
    expect(seedMessage("stale")).toBeNull();
    expect(seedMessage({ store: { width: 1, height: 1, tiles: new Map() }, classes: [], pixels: 1234, classCount: 3 })).toBe("Seeded 1234 pixels in 3 classes.");
  });

  it("holds spec 004's fixed strings", () => {
    expect(MESSAGES.labelFile).toBe("Label files must be single-band 8-bit GeoTIFFs.");
    expect(MESSAGES.minConfidence).toBe("Min. confidence must be between 0 and 1.");
    expect(MESSAGES.replace).toBe("Replace labels?");
    expect(MESSAGES.classTable("[2].value")).toBe("The class table is invalid: [2].value.");
  });
});
