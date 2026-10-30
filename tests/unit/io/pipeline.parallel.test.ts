import { describe, expect, it } from "vitest";
import type { Block } from "../../../src/core/imagery";
import { buildPreview } from "../../../src/io/pipeline";
import { samplesSource } from "../helpers/sources";

// Spec 025 scope 3: up to 4 preview reads in flight when each decodes at most 4 MiB, else 1.
const value = (b: number, c: number, r: number) => (b * 50 + c * 3 + r * 7) % 251;

/** samplesSource whose reads finish after a seeded random delay, logging how many run at once. */
function slowSource(block: Block) {
  const { source, reads } = samplesSource({ width: 2000, height: 1500, float: false }, value, block);
  const inner = source.readSamples!.bind(source);
  const log = { live: 0, peak: 0, started: 0 };
  let s = 3;
  source.readSamples = async (...args) => {
    log.started++;
    log.peak = Math.max(log.peak, ++log.live);
    await new Promise((r) => setTimeout(r, (s = (s * 7 + 3) % 11)));
    log.live--;
    return inner(...args);
  };
  return { source, reads, log };
}

const SMALL: Block = { width: 256, height: 256, bytes: 256 * 256 * 3 };
const BIG: Block = { ...SMALL, bytes: 4 * 2 ** 20 + 1 };

describe("preview reads in parallel (spec 025)", () => {
  it("keeps 4 reads in flight when each decodes at most 4 MiB, 1 otherwise, with the same preview and progress 1..total", async () => {
    const runs = await Promise.all([SMALL, { ...SMALL, bytes: 4 * 2 ** 20 }, BIG].map(async (block) => {
      const { source, reads, log } = slowSource(block);
      const progress: [number, number][] = [];
      const preview = await buildPreview(source, 256, { onProgress: (d, t) => progress.push([d, t]) });
      expect(progress).toEqual(reads.map((_, i) => [i + 1, reads.length]));
      return { preview, peak: log.peak, n: reads.length };
    }));
    expect(runs.map((r) => r.peak)).toEqual([4, 4, 1]);
    expect(runs[0]!.n).toBeGreaterThan(4);
    expect(runs[0]!.preview).toEqual(runs[2]!.preview);
  });

  it("starts no read after an abort and rejects with AbortError", async () => {
    const { source, log } = slowSource(SMALL);
    const ac = new AbortController();
    let startedAtAbort = -1;
    const p = buildPreview(source, 256, { signal: ac.signal, onProgress: (d) => { if (d === 2) { ac.abort(); startedAtAbort = log.started; } } });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 30));
    expect(log.started).toBe(startedAtAbort);
    expect(startedAtAbort).toBeLessThanOrEqual(6);
  });

  it("stops starting reads after one fails, rejects with its error, and reports no progress after", async () => {
    const { source, log } = slowSource(SMALL);
    const read = source.readSamples!;
    source.readSamples = (...args) => (log.started === 3 ? Promise.reject(new Error("disk")) : read(...args));
    let progress = 0;
    await expect(buildPreview(source, 256, { onProgress: () => progress++ })).rejects.toThrow("disk");
    const after = log.started, reported = progress;
    await new Promise((r) => setTimeout(r, 30));
    expect(log.started).toBe(after);
    expect(after).toBeLessThanOrEqual(4);
    expect(progress).toBe(reported);
  });
});
