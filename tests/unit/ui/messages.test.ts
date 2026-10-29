import { describe, expect, it } from "vitest";
import { RasterRefusedError } from "../../../src/io/pipeline";
import { errorText, MESSAGES, readErrorMessage, seedMessage } from "../../../src/ui/messages";

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

// Spec 019 criterion 10: a failure with no message still says something.
// Node has Event but not ProgressEvent; like the browser's, this one is an Event without a message.
const ProgressEventOrStub: typeof ProgressEvent = globalThis.ProgressEvent ?? (class ProgressEvent extends Event {} as unknown as typeof ProgressEvent);

describe("errorText and readErrorMessage", () => {
  const blank: [string, unknown][] = [["a ProgressEvent", new ProgressEventOrStub("error")], ["undefined", undefined], ["an empty Error", new Error("")]];

  it.each(blank)("give rasterUnreadable for %s", (_name, e) => {
    expect(MESSAGES.rasterUnreadable).toBe("Couldn't read this file.");
    expect(errorText(e)).toBe(MESSAGES.rasterUnreadable);
    expect(readErrorMessage(e)).toBe(MESSAGES.rasterUnreadable);
  });

  it("keep an Error's message, and the antimeridian and mask messages", () => {
    expect(errorText(new Error("x"))).toBe("x");
    expect(readErrorMessage(new Error("x"))).toBe("x");
    expect(errorText(new RasterRefusedError("antimeridian", "Raster extent crosses 180 degrees"))).toBe(MESSAGES.rasterAntimeridian);
    expect(errorText(new RasterRefusedError("crs", "Unsupported CRS EPSG:2056"))).toBe("Unsupported CRS EPSG:2056");
    expect(readErrorMessage(Object.assign(new Error("gone"), { name: "NotReadableError" }))).toBe(MESSAGES.maskGone);
  });
});
