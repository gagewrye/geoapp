import { describe, expect, it } from "vitest";
import { blockIndices, groupReads } from "../../../src/core/blocks";
import { decodedBytes, MAX_READ_BYTES, type Block } from "../../../src/core/imagery";
import type { Window } from "../../../src/core/grid";

// Tester, spec 028 criterion 7: blockIndices by brute force over random windows on tiles, strips and planar files;
// groupReads on random reads keeps order and every read, each group within its cap.

let s = 7;
const rnd = (n: number) => Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);

/** Every pixel of every window mapped to its block, in each plane given; sorted and unique. */
function brute(ws: Window[], b: Block, W: number, H: number, planes?: number[]) {
  const across = Math.ceil(W / b.width), per = across * Math.ceil(H / b.height), out = new Set<number>();
  for (const p of planes ?? [0]) for (const w of ws) {
    for (let y = w.y0; y < Math.min(H, w.y0 + w.height); y++) for (let x = w.x0; x < Math.min(W, w.x0 + w.width); x++) {
      out.add(p * per + Math.floor(y / b.height) * across + Math.floor(x / b.width));
    }
  }
  return [...out].sort((a, z) => a - z);
}
const randomWindows = (W: number, H: number) => Array.from({ length: 1 + rnd(4) }, () => {
  const x0 = rnd(W), y0 = rnd(H);
  return { x0, y0, width: 1 + rnd(W - x0), height: 1 + rnd(Math.min(300, H - y0)) };
});

describe("blockIndices by brute force", () => {
  const CASES: [string, Block, number, number][] = [
    ["256² tiles, partial edges", { width: 256, height: 256, bytes: 256 * 256 * 4 }, 1000, 700],
    ["100x60 tiles", { width: 100, height: 60, bytes: 100 * 60 * 4 }, 777, 333],
    ["1-row strips", { width: 640, height: 1, bytes: 640 * 4 }, 640, 400],
    ["16-row strips", { width: 900, height: 16, bytes: 900 * 16 * 4 }, 900, 250],
  ];
  for (const [name, b, W, H] of CASES) {
    it(name, () => {
      for (let i = 0; i < 60; i++) {
        const ws = randomWindows(W, H);
        expect(blockIndices(ws, b, W, H), JSON.stringify(ws)).toEqual(brute(ws, b, W, H));
        const planes = [rnd(4)];
        if (rnd(2)) planes.push(planes[0]! + 1 + rnd(2));
        expect(blockIndices(ws, b, W, H, planes), `${JSON.stringify(ws)} planes ${planes}`).toEqual(brute(ws, b, W, H, planes));
      }
    });
  }
});

describe("groupReads on random reads", () => {
  it("keeps every read in order, and each group of several reads decodes at most the cap", () => {
    const b: Block = { width: 256, height: 256, bytes: 256 * 256 * 4 }, W = 20000, H = 512;
    for (const cap of [MAX_READ_BYTES, 3 * b.bytes, b.bytes]) {
      const reads = Array.from({ length: 80 }, (_, i) => ({ x0: i * 250, y0: 0, width: 1 + rnd(600), height: 1 + rnd(512) })).filter((r) => r.x0 < W);
      const groups = groupReads(reads, b, W, H, cap);
      expect(groups.flat()).toEqual(reads);
      for (const g of groups) if (g.length > 1) expect(g.reduce((n, w) => n + decodedBytes(w, b, W, H), 0)).toBeLessThanOrEqual(cap);
    }
  });
});
