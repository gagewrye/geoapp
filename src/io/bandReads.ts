import { groupReads } from "../core/blocks";
import type { Window } from "../core/grid";
import { MAX_READ_BYTES, rowReads, TASK_READ_BYTES } from "../core/imagery";
import { TILE_SIZE } from "../core/types";
import type { RasterSource } from "./source";

/** A read's window and its samples, in the order asked for. */
export type BandRead = Window & { bands: ArrayLike<number>[] };

/** How a mask band's plan is read: spec 020's rowReads, in groups whose file bytes are held together (spec 023 F2, 028). */
export function bandReads(source: RasterSource, plan: Window[], samples: number[]) {
  const { width, height, bandCount } = source.meta;
  const { block, readSamples, raw } = source;
  // geotiff decodes a read in one task, so its reads are smaller (spec 028); raw reads copy only the samples asked for
  const cap = raw?.includes(0) ? MAX_READ_BYTES : TASK_READ_BYTES;
  const sampled = block && readSamples ? { block, readSamples } : null;
  const reads = rowReads(plan, 1, sampled?.block ?? { width: TILE_SIZE, height: 1, bytes: TILE_SIZE * bandCount * 4 }, width, height, sampled ? cap : MAX_READ_BYTES);
  const read = sampled
    ? async (r: Window): Promise<BandRead> => ({ ...r, bands: await sampled.readSamples.call(source, 0, r.x0, r.y0, r.width, r.height, samples) })
    // readWindow decodes every band as Float32: its reads are bounded as if each 256 px row segment were a block
    : async (r: Window): Promise<BandRead> => {
      const t = await source.readWindow(r.x0, r.y0, r.width, r.height);
      return { ...r, bands: samples.map((k) => t.bands[k]!) };
    };
  // capped reads would each wait on a file call: their file bytes are held a group (≤ MAX_READ_BYTES decoded) at a time
  const held = sampled && cap === TASK_READ_BYTES ? source.hold : undefined;
  const groups = held ? groupReads(reads, sampled!.block, width, height, MAX_READ_BYTES) : [reads];
  const hold = held ? (g: Window[]) => held.call(source, 0, g, samples) : undefined;
  return { count: reads.length, groups, read, hold };
}
