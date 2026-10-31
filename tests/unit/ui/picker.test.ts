import { describe, expect, it, vi } from "vitest";
import { initPicker } from "../../../src/ui/picker";

// Spec 038 criterion 3, with fake tiles: the 512 x 512 store's tile 256,0 holds value v at pixel (300 + v, 10).
const classes = [{ name: "Water", colour: "#000000" }, { name: "Sand", colour: "#111111" }, { name: "Mangrove", colour: "#222222" }];
const tile = () => { const t = new Uint8Array(256 * 256); for (const v of [1, 2, 3]) t[10 * 256 + 44 + v] = v; return t; };

function setup(read: (key: string) => Promise<Uint8Array | null> = async () => tile()) {
  const select = vi.fn(), say = vi.fn(), keys: string[] = [];
  const pick = initPicker({ tile: (k) => { keys.push(k); return read(k); }, dims: () => ({ width: 512, height: 512 }), classes: () => classes, select, say });
  return { pick, select, say, keys };
}

describe("picker", () => {
  it("a pixel of value 3 selects index 2 and says Picked Mangrove.", async () => {
    const t = setup();
    await t.pick([303, 10]);
    expect(t.keys).toEqual(["256,0"]);
    expect(t.select).toHaveBeenCalledWith(2);
    expect(t.say).toHaveBeenCalledWith("Picked Mangrove.", "info");
  });

  it("a pixel of value 0, or with no tile at all, keeps the selection and says No label here.", async () => {
    const t = setup();
    await t.pick([400, 10]);
    const none = setup(async () => null);
    await none.pick([10, 10]);
    for (const s of [t, none]) {
      expect(s.select).not.toHaveBeenCalled();
      expect(s.say).toHaveBeenCalledWith("No label here.", "info");
    }
  });

  it("of two overlapping picks only the second applies", async () => {
    let release = () => {};
    const slow = new Promise<void>((r) => { release = r; });
    let n = 0;
    const t = setup(async () => { if (n++ === 0) await slow; return tile(); });
    const first = t.pick([301, 10]);
    await t.pick([302, 10]);
    release();
    await first;
    expect(t.select.mock.calls).toEqual([[1]]);
    expect(t.say.mock.calls).toEqual([["Picked Sand.", "info"]]);
  });
});
