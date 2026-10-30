import { describe, expect, it, vi } from "vitest";
import { yieldToBrowser } from "../../../src/io/yieldTask";

describe("yieldToBrowser (spec 028)", () => {
  it("resolves in a later task, through a MessageChannel post, after every queued microtask", async () => {
    const spy = vi.spyOn(globalThis, "MessageChannel");
    const order: string[] = [];
    const y = yieldToBrowser().then(() => order.push("yield"));
    let p = Promise.resolve();
    for (let i = 0; i < 50; i++) p = p.then(() => { order.push("micro"); });
    await y;
    expect(order).toEqual([...Array(50).fill("micro"), "yield"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
