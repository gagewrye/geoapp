import { describe, expect, it, vi } from "vitest";
import { errorText } from "../../../src/ui/messages";
import { initPicker } from "../../../src/ui/picker";

// Spec 038 criterion 3, with fake tiles: the 512 x 512 store's tile 256,0 holds value v at pixel (300 + v, 10).
const classes = [{ name: "Water", colour: "#000000" }, { name: "Sand", colour: "#111111" }, { name: "Mangrove", colour: "#222222" }];
const tile = () => { const t = new Uint8Array(256 * 256); for (const v of [1, 2, 3]) t[10 * 256 + 44 + v] = v; return t; };

function setup(read: (key: string) => Promise<Uint8Array | null> = async () => tile()) {
  const select = vi.fn(), say = vi.fn(), keys: string[] = [];
  let dims = { width: 512, height: 512 };
  const picker = initPicker({ tile: (k) => { keys.push(k); return read(k); }, dims: () => dims, classes: () => classes, select, say });
  return { pick: picker.pick, cancel: picker.cancel, select, say, keys, shrink: () => { dims = { width: 100, height: 100 }; } };
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

  it("a failed tile read says errorText as an error, keeps the selection, and its promise resolves (no unhandled rejection)", async () => {
    const err = new Error("The label mask can't be read.");
    const t = setup(async () => { throw err; });
    await expect(t.pick([303, 10])).resolves.toBeUndefined();
    expect(t.select).not.toHaveBeenCalled();
    expect(t.say.mock.calls).toEqual([[errorText(err), "error"]]);
  });

  it("a failed read superseded by a newer pick says nothing", async () => {
    let fail = (_e: Error) => {};
    const t = setup(async (k) => (t.keys.length === 1 ? new Promise<never>((_r, j) => { fail = j; }) : (void k, tile())));
    const first = t.pick([301, 10]);
    await t.pick([302, 10]);
    fail(new Error("late"));
    await first;
    expect(t.say.mock.calls).toEqual([["Picked Sand.", "info"]]);
  });

  // Spec 039 criteria 7 and 9.
  for (const outcome of ["resolves", "rejects"] as const) {
    it(`a pick whose read ${outcome} after cancel() calls neither select nor say, even with dims shrunk past its cell`, async () => {
      let settle = () => {};
      const t = setup(() => new Promise((ok, fail) => { settle = () => (outcome === "resolves" ? ok(tile()) : fail(new Error("gone"))); }));
      const p = t.pick([303, 10]);
      t.cancel();
      t.shrink(); // a smaller raster opened: 303,10 is outside its tile windows
      settle();
      await expect(p).resolves.toBeUndefined();
      expect(t.select).not.toHaveBeenCalled();
      expect(t.say).not.toHaveBeenCalled();
    });
  }

  it("with 3 classes a value of 5 keeps the selection and says No class for value 5.; 0 still says No label here.", async () => {
    const t = setup(async () => { const x = tile(); x[10 * 256 + 49] = 5; return x; });
    await t.pick([305, 10]);
    expect(t.select).not.toHaveBeenCalled();
    expect(t.say.mock.calls).toEqual([["No class for value 5.", "info"]]);
    await t.pick([400, 10]);
    expect(t.say.mock.calls[1]).toEqual(["No label here.", "info"]);
  });
});
