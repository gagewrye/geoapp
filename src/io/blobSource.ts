import { mergeRanges, type Range } from "../core/ranges";

/** Holes up to this size are read through rather than split into another call (ADR 0022). */
export const MERGE_GAP = 64 * 1024;
/** No merged read is longer than this, so one run never holds more than a block-sized buffer. */
export const MAX_FETCH = 16 * 2 ** 20;

type Request = { slices: Range[]; out: ArrayBuffer[]; left: number; resolve(b: ArrayBuffer[]): void; reject(e: unknown): void; done: boolean; signal?: AbortSignal; onAbort?: () => void };

/** geotiff.js source over a Blob that reads each run of nearby slices requested in one task with one call (spec 025). */
export function blobSource(blob: Blob) {
  const size = blob.size;
  let queue: Request[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settle = (r: Request) => {
    r.done = true;
    if (r.onAbort) r.signal!.removeEventListener("abort", r.onAbort);
  };

  function flush() {
    timer = null;
    const batch = queue.filter((r) => !r.done);
    queue = [];
    const ranges: Range[] = [], owners: [Request, number][] = [];
    for (const r of batch) r.slices.forEach(({ offset, length }, j) => {
      const start = Math.min(offset, size), end = Math.min(offset + length, size);
      if (end > start) { ranges.push({ offset: start, length: end - start }); owners.push([r, j]); } else give(r, j, new ArrayBuffer(0));
    });
    for (const run of mergeRanges(ranges, MERGE_GAP, MAX_FETCH)) {
      blob.slice(run.offset, run.offset + run.length).arrayBuffer().then((buf) => {
        for (const m of run.members) {
          const { offset, length } = ranges[m]!, at = offset - run.offset;
          // each caller gets its own buffer: geotiff's raw decoder returns it and the predictor then rewrites it in place
          give(owners[m]![0], owners[m]![1], run.members.length === 1 ? buf : buf.slice(at, at + length));
        }
      }, (e: unknown) => {
        for (const m of run.members) fail(owners[m]![0], e);
      });
    }
  }

  function give(r: Request, j: number, buf: ArrayBuffer) {
    if (r.done) return;
    r.out[j] = buf;
    if (--r.left === 0) { settle(r); r.resolve(r.out); }
  }

  function fail(r: Request, e: unknown) {
    if (r.done) return;
    settle(r);
    r.reject(e);
  }

  return {
    fileSize: size,
    fetch(slices: Range[], signal?: AbortSignal): Promise<ArrayBuffer[]> {
      const aborted = () => new DOMException("Read aborted", "AbortError");
      if (signal?.aborted) return Promise.reject(aborted());
      if (slices.length === 0) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        const r: Request = { slices, out: new Array<ArrayBuffer>(slices.length), left: slices.length, resolve, reject, done: false, signal };
        if (signal) { r.onAbort = () => fail(r, aborted()); signal.addEventListener("abort", r.onAbort); }
        queue.push(r);
        // a macrotask, so every block fetch geotiff starts for one readRasters call lands in the same batch
        timer ??= setTimeout(flush, 0);
      });
    },
  };
}
