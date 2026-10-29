import { describe, expect, it } from "vitest";
import { MESSAGES, seedMessage } from "../../../src/ui/messages";

// Spec 004 criterion 16: ui maps "too many" to its message; the rest of the import messages.

describe("seedMessage", () => {
  it("maps each outcome to the spec's message, and a stale run to none", () => {
    expect(seedMessage("too many")).toBe("Too many classes (max 255). Nothing was seeded.");
    expect(seedMessage("empty")).toBe("No labels to seed here.");
    expect(seedMessage("stale")).toBeNull();
    expect(seedMessage({ store: { width: 1, height: 1, tiles: new Map(), base: true }, classes: [], base: null as never, pixels: 1234, classCount: 3 })).toBe("Seeded 1234 pixels in 3 classes.");
  });

  it("holds spec 004's fixed strings", () => {
    expect(MESSAGES.labelFile).toBe("Label files must be single-band 8-bit GeoTIFFs.");
    expect(MESSAGES.replace).toBe("Replace labels?");
    expect(MESSAGES.classTable("[2].value")).toBe("The class table is invalid: [2].value.");
  });
});
