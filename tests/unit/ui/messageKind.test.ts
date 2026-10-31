import { describe, expect, it } from "vitest";
import { errorText, MESSAGES, messageSink, readErrorMessage } from "../../../src/ui/messages";

// Spec 032 criterion 2: errors set class error on #message; info messages don't.
function fakeEl() {
  const classes = new Set<string>();
  return { textContent: "" as string | null, classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } }, classes };
}

describe("message kinds", () => {
  const errors = [
    errorText(new Error("boom")), readErrorMessage(new Error("bad read")), MESSAGES.labelFile, MESSAGES.classTable("[1].value"), MESSAGES.className,
    MESSAGES.labelLimit, MESSAGES.editLimit, MESSAGES.maskGone, MESSAGES.imageryUnreadable, MESSAGES.largeBlocks(2 ** 25, 2 ** 24),
    MESSAGES.rasterAntimeridian, MESSAGES.tooMany,
  ];
  it("each error sets class error, and the next info message clears it", () => {
    const el = fakeEl(), say = messageSink(el);
    for (const text of errors) {
      say(text, "error");
      expect(el.textContent).toBe(text);
      expect(el.classes.has("error")).toBe(true);
      say("Raster opened.");
      expect(el.classes.has("error")).toBe(false);
    }
  });

  it("Raster opened., Labels exported., Importing labels… and Seeded … are info", () => {
    const el = fakeEl(), say = messageSink(el);
    for (const text of ["Raster opened.", "Labels exported.", MESSAGES.importing, "Seeded 12 pixels in 2 classes."]) {
      say(text);
      expect(el.classes.has("error")).toBe(false);
    }
  });
});
