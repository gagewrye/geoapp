/** A byte range, as geotiff.js asks its source for one. */
export type Range = { offset: number; length: number };

/** A run of ranges read as one: `members` are indexes into the input, in offset order. */
export type Run = Range & { members: number[] };

/**
 * Joins ranges whose holes are at most `gap` bytes into runs of at most `max` bytes (spec 025);
 * a range longer than `max` is a run of its own.
 */
export function mergeRanges(ranges: Range[], gap: number, max: number): Run[] {
  const order = ranges.map((_, i) => i).sort((a, b) => ranges[a]!.offset - ranges[b]!.offset || a - b);
  const runs: Run[] = [];
  let run: Run | null = null;
  for (const i of order) {
    const { offset, length } = ranges[i]!;
    const end = offset + length;
    if (run) {
      const runEnd = run.offset + run.length;
      if (offset - runEnd <= gap && Math.max(runEnd, end) - run.offset <= max) {
        run.length = Math.max(runEnd, end) - run.offset;
        run.members.push(i);
        continue;
      }
    }
    run = { offset, length, members: [i] };
    runs.push(run);
  }
  return runs;
}
