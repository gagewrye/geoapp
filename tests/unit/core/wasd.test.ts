import { describe, expect, it } from "vitest";
import { WASD_MAX_DT, WASD_SPEED, wasdStep, type WasdKey } from "../../../src/core/wasd";

const step = (keys: WasdKey[], dt: number) => wasdStep(new Set(keys), dt);
const close = (a: [number, number], b: [number, number]) => { expect(a[0]).toBeCloseTo(b[0], 10); expect(a[1]).toBeCloseTo(b[1], 10); };

describe("wasdStep (spec 009 criterion 4)", () => {
  it("has the spec's constants", () => {
    expect(WASD_SPEED).toBe(600);
    expect(WASD_MAX_DT).toBe(50);
  });

  it("W at dt 16 moves 9.6 px up the screen; D 9.6 px right", () => {
    close(step(["KeyW"], 16), [0, -9.6]);
    close(step(["KeyD"], 16), [9.6, 0]);
    close(step(["KeyS"], 16), [0, 9.6]);
    close(step(["KeyA"], 16), [-9.6, 0]);
  });

  it("W+D gives length 9.6 at 45 degrees", () => {
    const [dx, dy] = step(["KeyW", "KeyD"], 16);
    expect(Math.hypot(dx, dy)).toBeCloseTo(9.6, 10);
    expect(dx).toBeCloseTo(-dy, 10);
    expect(dx).toBeGreaterThan(0);
  });

  it("opposite keys cancel; W+A+S gives A's step", () => {
    expect(step(["KeyW", "KeyS"], 16)).toEqual([0, 0]);
    expect(step(["KeyA", "KeyD"], 16)).toEqual([0, 0]);
    expect(step([], 16)).toEqual([0, 0]);
    close(step(["KeyW", "KeyA", "KeyS"], 16), step(["KeyA"], 16));
  });

  it("clamps a long frame gap to WASD_MAX_DT", () => {
    expect(step(["KeyD"], 200)).toEqual(step(["KeyD"], 50));
    close(step(["KeyD"], 50), [30, 0]);
  });
});
