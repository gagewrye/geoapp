import { describe, expect, it } from "vitest";
import type { Block } from "../../../src/core/imagery";
import { MaskCache, STROKE } from "../../../src/io/maskCache";
import type { ImagerySource } from "../../../src/io/source";
import { samplesSource } from "../helpers/sources";

// Tester, spec 024 with 028 item 2: held file bytes are always released, when a read in the group fails and when the cache stops mid-group.

const W = 2560, H = 512;
const tiles: Block = { width: 256, height: 256, bytes: 4 * 2 ** 20 };
const value = (k: number, c: number) => (k === 3 ? (c % 7 ? 255 : 0) : 100);

function source(onRead: (x0: number, n: number) => Promise<void> | void) {
  const { source: inner } = samplesSource({ width: W, height: H, bandCount: 4, alpha: 3, nodata: null, float: false }, value, tiles);
  const state = { held: 0, holds: 0, reads: 0 };
  const s: ImagerySource = {
    ...inner,
    async readSamples(...a) { await onRead(a[1], ++state.reads); return inner.readSamples(...a); },
    async hold() { state.held++; state.holds++; return () => { state.held--; }; },
  };
  return { s, state };
}

describe("held bytes are released", () => {
  it("when a read in a held group fails: the need rejects and nothing stays held", async () => {
    const { s, state } = source((_x, n) => { if (n === 2) throw new DOMException("changed", "NotReadableError"); });
    const e = await new MaskCache(s).need(0, STROKE).catch((x: unknown) => x);
    expect((e as Error).name).toBe("NotReadableError");
    expect(state.holds).toBe(1);
    expect(state.held).toBe(0);
  });

  it("when the cache stops mid-group (another raster opened): nothing stays held and no later group is held", async () => {
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    const { s, state } = source((_x, n) => (n === 2 ? gate : undefined));
    const cache = new MaskCache(s);
    const p = cache.need(0, STROKE).catch(() => "stopped");
    while (state.reads < 2) await new Promise((r) => setTimeout(r, 1));
    expect(state.held).toBe(1);
    cache.stop();
    go();
    expect(await p).toBe("stopped");
    await new Promise((r) => setTimeout(r, 20));
    expect([state.held, state.holds]).toEqual([0, 1]);
  });
});
