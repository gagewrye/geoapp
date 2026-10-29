// Fragment of tests/unit/ui/messages.test.ts (spec 013): the model-seed strings, to merge back by hand with MESSAGES.modelNames and minConfidence.
import { describe, expect, it } from "vitest";
import { MESSAGES, seedMessage } from "../../../src/ui/messages";

describe("seedMessage", () => {
  it("maps a model with bad names to its message", () => {
    expect(seedMessage("bad names")).toBe("The model's class names must be unique and not empty, with no spaces around them. Nothing was seeded.");
  });

  it("holds spec 004's Min. confidence string", () => {
    expect(MESSAGES.minConfidence).toBe("Min. confidence must be between 0 and 1.");
  });
});
