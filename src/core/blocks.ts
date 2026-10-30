import type { Window } from "./grid";
import { decodedBytes, type Block } from "./imagery";

/** Indexes of the blocks the windows of a width x height image touch, ascending; a planar file's planes (the samples read) follow each other. */
export function blockIndices(windows: Window[], block: Pick<Block, "width" | "height">, width: number, height: number, planes: number[] = [0]): number[] {
  const across = Math.ceil(width / block.width), perPlane = across * Math.ceil(height / block.height);
  const out = new Set<number>();
  for (const p of planes) for (const w of windows) {
    const x1 = Math.min(w.x0 + w.width, width), y1 = Math.min(w.y0 + w.height, height);
    for (let by = Math.floor(w.y0 / block.height); by * block.height < y1; by++)
      for (let bx = Math.floor(w.x0 / block.width); bx * block.width < x1; bx++) out.add(p * perPlane + by * across + bx);
  }
  return [...out].sort((a, b) => a - b);
}

/** Consecutive reads grouped so each group decodes at most `max` bytes; a read over `max` is a group of its own. */
export function groupReads(reads: Window[], block: Block, width: number, height: number, max: number): Window[][] {
  const groups: Window[][] = [];
  let cur: Window[] = [], bytes = 0;
  for (const r of reads) {
    const b = decodedBytes(r, block, width, height);
    if (cur.length && bytes + b > max) { groups.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += b;
  }
  if (cur.length) groups.push(cur);
  return groups;
}
