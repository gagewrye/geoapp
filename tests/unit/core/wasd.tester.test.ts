import { describe, expect, it } from "vitest";
import { WASD_MAX_DT, WASD_SPEED, wasdStep, type WasdKey } from "../../../src/core/wasd";

// Tester edge cases for spec 009 criterion 4: every key combination, the clamp boundary, and dt 0.
const KEYS: WasdKey[] = ["KeyW", "KeyA", "KeyS", "KeyD"];
const subsets = (): WasdKey[][] => Array.from({ length: 16 }, (_, m) => KEYS.filter((_k, i) => m & (1 << i)));

describe("wasdStep over all 16 key sets (tester)", () => {
  for (const keys of subsets()) {
    it(`{${keys.join(",")}}: speed x dt along (D-A, S-W), or [0, 0]`, () => {
      const x = (keys.includes("KeyD") ? 1 : 0) - (keys.includes("KeyA") ? 1 : 0);
      const y = (keys.includes("KeyS") ? 1 : 0) - (keys.includes("KeyW") ? 1 : 0);
      for (const dt of [0, 1, 16, 33.3, 49.999, 50, 50.001, 1000]) {
        const [dx, dy] = wasdStep(new Set(keys), dt);
        const len = (WASD_SPEED * Math.min(dt, WASD_MAX_DT)) / 1000;
        if (x === 0 && y === 0) { expect([dx, dy]).toEqual([0, 0]); continue; }
        expect(Math.hypot(dx, dy)).toBeCloseTo(len, 9);
        if (len > 0) { expect(Math.sign(dx)).toBe(Math.sign(x)); expect(Math.sign(dy)).toBe(Math.sign(y)); }
      }
    });
  }
  it("dt 0 moves nothing; the clamp makes dt 50 and dt 1e6 equal (30 px)", () => {
    expect(Math.hypot(...wasdStep(new Set(["KeyW"]), 0))).toBe(0);
    expect(wasdStep(new Set(["KeyD"]), 1e6)).toEqual(wasdStep(new Set(["KeyD"]), 50));
    expect(wasdStep(new Set(["KeyD"]), 50)[0]).toBeCloseTo(30, 10);
  });
  it("does not mutate the held set", () => {
    const s = new Set<WasdKey>(["KeyW", "KeyD"]);
    wasdStep(s, 16);
    expect([...s]).toEqual(["KeyW", "KeyD"]);
  });
});
