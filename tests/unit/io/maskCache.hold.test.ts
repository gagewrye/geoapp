import { describe, expect, it } from "vitest";
import { decodedBytes, MAX_READ_BYTES, TASK_READ_BYTES, type Block } from "../../../src/core/imagery";
import type { Window } from "../../../src/core/grid";
import { MaskCache, STROKE } from "../../../src/io/maskCache";
import type { ImagerySource } from "../../../src/io/source";
import { TASK_BUDGET_MS } from "../../../src/io/yieldTask";
import { samplesSource } from "../helpers/sources";

// Spec 024 criterion 5 with spec 028 item 2: a band's capped geotiff reads are served from file bytes held a group at a time,
// so they don't each wait on a file call, and the reads yield to the browser after TASK_BUDGET_MS of work.

const W = 2560, H = 512; // 10 tiles of 256² per band
const tiles: Block = { width: 256, height: 256, bytes: 4 * 2 ** 20 }; // over TASK_READ_BYTES: each read is one tile, 4 tiles per hold
const value = (k: number, c: number, r: number) => (k === 3 ? ((c * 3 + r) % 101 === 0 ? 0 : 255) : 100);

function held(raw?: number[]) {
  const { source, reads } = samplesSource({ width: W, height: H, bandCount: 4, alpha: 3, nodata: null, float: false }, value, tiles);
  const log: string[] = [];
  const holds: Window[][] = [];
  const s: ImagerySource = {
    ...source, raw,
    async readSamples(...a) { log.push(`read ${a[1]}`); return source.readSamples(...a); },
    async hold(image, windows, bands) {
      expect(image).toBe(0);
      expect(bands).toEqual([3]);
      holds.push(windows);
      log.push(`hold ${windows.map((w) => w.x0).join(",")}`);
      return () => log.push("release");
    },
  };
  return { source: s, reads, log, holds, plain: samplesSource({ width: W, height: H, bandCount: 4, alpha: 3, nodata: null, float: false }, value, tiles).source };
}

describe("held band reads", () => {
  it("holds each group of reads (at most MAX_READ_BYTES decoded) before reading it and releases it after, with masks equal to unheld reads", async () => {
    const { source, reads, log, holds, plain } = held();
    const a = new MaskCache(source), b = new MaskCache(plain);
    await Promise.all([a.need(0, STROKE), b.need(0, STROKE)]);
    expect(reads).toHaveLength(10);
    expect(reads.every((r) => r.width === 256 && tiles.bytes > TASK_READ_BYTES)).toBe(true); // a block over the cap is read alone
    expect(holds.map((g) => g.map((w) => w.x0))).toEqual([[0, 256, 512, 768], [1024, 1280, 1536, 1792], [2048, 2304]]);
    for (const g of holds) expect(g.reduce((n, w) => n + decodedBytes(w, tiles, W, H), 0)).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(log).toEqual([
      "hold 0,256,512,768", "read 0", "read 256", "read 512", "read 768", "release",
      "hold 1024,1280,1536,1792", "read 1024", "read 1280", "read 1536", "read 1792", "release",
      "hold 2048,2304", "read 2048", "read 2304", "release",
    ]);
    for (let x0 = 0; x0 < W; x0 += 256) expect(a.get(`${x0},0`)).toEqual(b.get(`${x0},0`));
  });

  it("an import's band reads only the windows asked for, and holds only them", async () => {
    const { source, holds } = held();
    await new MaskCache(source).need(256, STROKE, [512, 2304]);
    expect(holds.map((g) => g.map((w) => w.x0))).toEqual([[512, 2304]]);
  });

  it("a raw image holds nothing", async () => {
    const { source, holds } = held([0]);
    await new MaskCache(source).need(0, STROKE);
    expect(holds).toEqual([]);
  });

  it("yields after TASK_BUDGET_MS of reads in a band, with a fake clock", async () => {
    const { source, log } = held();
    let t = 0;
    const s: ImagerySource = { ...source, async readSamples(...a) { t += TASK_BUDGET_MS / 2; return source.readSamples(...a); } };
    const cache = new MaskCache(s, { now: () => t, yieldTask: async () => { log.push("yield"); } });
    await cache.need(0, STROKE);
    // two reads fill the budget: a yield follows every second read, but not the band's last
    expect(log.filter((x) => x.startsWith("read") || x === "yield").join(" ")).toBe(
      "read 0 read 256 yield read 512 read 768 yield read 1024 read 1280 yield read 1536 read 1792 yield read 2048 read 2304");
  });
});
