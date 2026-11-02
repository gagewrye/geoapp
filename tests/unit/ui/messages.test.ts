import { describe, expect, it } from "vitest";
import { RasterRefusedError } from "../../../src/io/pipeline";
import { classMapMessage, errorText, MESSAGES, readErrorMessage, seedMessage } from "../../../src/ui/messages";

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
  });
});

describe("spec 047's messages", () => {
  const ok = { store: { width: 1, height: 1, tiles: new Map(), base: true }, classes: [], base: null as never, pixels: 12, classCount: 2 };
  const v = { field: "[0].value", why: "is the file's nodata 0" }, n = { field: "[3].name", why: "must be a unique, non-empty string" };

  it("a successful import names the first part of the file's class table it ignored, and how many more", () => {
    expect(seedMessage(ok, [])).toBe("Seeded 12 pixels in 2 classes.");
    expect(seedMessage(ok, [v])).toBe("Seeded 12 pixels in 2 classes. Ignored part of the file's class table: [0].value is the file's nodata 0.");
    expect(seedMessage(ok, [v, n, n])).toBe("Seeded 12 pixels in 2 classes. Ignored part of the file's class table: [0].value is the file's nodata 0 (+2 more).");
    expect(seedMessage("empty", [v])).toBe(MESSAGES.noSeed);
  });

  it("Apply class map says how many classes changed, or matched none as an error, and the first skip", () => {
    expect(classMapMessage(2, [])).toEqual({ text: "Class map applied to 2 classes.", kind: "info" });
    expect(classMapMessage(7, [{ field: "[0].value", why: "has no class in these labels" }]).text).toBe("Class map applied to 7 classes. Skipped: [0].value has no class in these labels.");
    expect(classMapMessage(0, [{ field: "JSON", why: "is not valid JSON" }])).toEqual({ text: "Class map matched no class. Skipped: JSON is not valid JSON.", kind: "error" });
    expect(classMapMessage(0, [])).toEqual({ text: "Class map matched no class.", kind: "error" });
    expect(classMapMessage(1, [v, n]).text).toBe("Class map applied to 1 classes. Skipped: [0].value is the file's nodata 0 (+1 more).");
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
