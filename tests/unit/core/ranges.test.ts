import { describe, expect, it } from "vitest";
import { mergeRanges } from "../../../src/core/ranges";

// Spec 025 criterion 1.
type R = { offset: number; length: number };

/** Seeded random ranges, some overlapping, some adjacent, some far apart. */
function ranges(n: number, seed: number): R[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, () => ({ offset: Math.floor(rnd() * 5000), length: 1 + Math.floor(rnd() * (rnd() < 0.1 ? 900 : 120)) }));
}

describe("mergeRanges (criterion 1)", () => {
  it("covers every input with exactly one run, by index, and no run passes max unless one input does", () => {
    for (let seed = 1; seed < 40; seed++) for (const [gap, max] of [[0, 300], [64, 500], [10, 100], [1000, 100000]]) {
      const input = ranges(60, seed);
      const runs = mergeRanges(input, gap!, max!);
      const seen = runs.flatMap((r) => r.members).sort((a, b) => a - b);
      expect(seen).toEqual(input.map((_, i) => i));
      for (const run of runs) {
        for (const i of run.members) {
          expect(input[i]!.offset).toBeGreaterThanOrEqual(run.offset);
          expect(input[i]!.offset + input[i]!.length).toBeLessThanOrEqual(run.offset + run.length);
        }
        if (run.length > max!) expect(run.members.length === 1 && input[run.members[0]!]!.length === run.length).toBe(true);
        // the run starts at its first member and ends at its last byte
        expect(Math.min(...run.members.map((i) => input[i]!.offset))).toBe(run.offset);
        expect(Math.max(...run.members.map((i) => input[i]!.offset + input[i]!.length))).toBe(run.offset + run.length);
      }
    }
  });

  it("never bridges a gap over `gap`", () => {
    for (let seed = 1; seed < 40; seed++) {
      const input = ranges(40, seed);
      for (const run of mergeRanges(input, 16, 1e9)) {
        // the members' union, sorted, has no hole wider than 16
        const spans = run.members.map((i) => input[i]!).sort((a, b) => a.offset - b.offset);
        let end = spans[0]!.offset;
        for (const r of spans) { expect(r.offset - end).toBeLessThanOrEqual(16); end = Math.max(end, r.offset + r.length); }
      }
    }
    expect(mergeRanges([{ offset: 0, length: 10 }, { offset: 27, length: 5 }], 16, 1e9)).toEqual([
      { offset: 0, length: 10, members: [0] }, { offset: 27, length: 5, members: [1] }]);
    expect(mergeRanges([{ offset: 26, length: 5 }, { offset: 0, length: 10 }], 16, 1e9)).toEqual([{ offset: 0, length: 31, members: [1, 0] }]);
  });

  it("fetches an input larger than max alone, and gives nothing for no inputs", () => {
    expect(mergeRanges([{ offset: 0, length: 10 }, { offset: 10, length: 500 }, { offset: 510, length: 10 }], 64, 100)).toEqual([
      { offset: 0, length: 10, members: [0] }, { offset: 10, length: 500, members: [1] }, { offset: 510, length: 10, members: [2] }]);
    expect(mergeRanges([], 64, 100)).toEqual([]);
  });
});
