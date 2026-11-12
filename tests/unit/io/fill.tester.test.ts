import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import type { Span } from "../../../src/core/spans";
import { floodFill, type FillRead, type FillResult } from "../../../src/io/fill";

// Spec 059 tester: floodFill's hole pass at the reach's edge, with null labels and nodata, and that it reads no tile.
type Px = (c: number, r: number) => number;
const cells = (spans: Span[]) => new Set(spans.flatMap((s) => Array.from({ length: s.x1 - s.x0 }, (_, i) => `${s.x0 + i},${s.row}`)));

/** A reader logging each read; tiles for which `blank` is true come back with null labels. */
function reader(label: Px, valid: Px = () => 1, blank: (t: Window) => boolean = () => false) {
  const reads: Window[] = [];
  const read: FillRead = async (_key, t) => {
    reads.push(t);
    const n = t.width * t.height, mask = new Uint8Array(Math.ceil(n / 8));
    const labels = blank(t) ? null : new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const c = t.x0 + (i % t.width), r = t.y0 + Math.floor(i / t.width);
      if (labels) labels[i] = label(c, r);
      if (!valid(c, r)) mask[i >> 3]! |= 1 << (i & 7);
    }
    return { labels, mask };
  };
  return { read, reads };
}
const tileSet = (reads: Window[]) => reads.map((w) => `${w.x0},${w.y0}`).sort();

describe("floodFill holes (spec 059, tester)", () => {
  // 14 x 14 tiles; a click in tile (7,7) reaches tiles 3..11, so pixels 768..3071 are known
  const dims = { width: 256 * 14, height: 256 * 14 }, click: [number, number] = [256 * 7 + 3, 256 * 7 + 9];
  const lo = 256 * 3, hi = 256 * 12 - 1;

  it("leaves specks on every side of the reach's edge and its corners, fills them one pixel in, and reads the same 81 tiles once each", async () => {
    const edge = [[lo, 2000], [hi, 2000], [2000, lo], [2000, hi], [lo, lo], [hi, hi], [lo + 5, lo], [hi - 5, hi]]; // stay
    const inner = [[lo + 1, 2100], [hi - 1, 2100], [2100, lo + 1], [2100, hi - 1], [lo + 1, lo + 1], [hi - 1, hi - 1]]; // filled
    const specks = new Set([...edge, ...inner].map(String));
    const label: Px = (c, r) => (specks.has(`${c},${r}`) ? 5 : 0);
    const a = reader(label), plain = reader(() => 0);
    const r = (await floodFill(dims, click, 1, a.read)) as FillResult;
    await floodFill(dims, click, 1, plain.read);
    expect(tileSet(a.reads)).toEqual(tileSet(plain.reads));
    expect(new Set(tileSet(a.reads)).size).toBe(81);
    expect(a.reads).toHaveLength(81);
    for (const w of a.reads) expect(w.width <= 256 && w.height <= 256).toBe(true);
    const got = cells(r.spans);
    expect(edge.filter((p) => got.has(String(p)))).toEqual([]);
    expect(inner.filter((p) => !got.has(String(p)))).toEqual([]);
    expect(r.pixels).toBe((256 * 9) ** 2 - edge.length);
    expect(r.clipped).toBe(true);
  });

  it("an unlabelled target over tiles with null labels overwrites enclosed class specks in labelled tiles, across a four-tile corner", async () => {
    const dims2 = { width: 700, height: 600 };
    const specks = new Map([["255,255", 2], ["256,256", 4], ["511,300", 1], ["512,300", 1], ["600,590", 7], ["600,599", 7]]);
    const label: Px = (c, r) => specks.get(`${c},${r}`) ?? 0;
    // tiles holding no speck have no labels at all
    const blank = (t: Window) => ![...specks.keys()].some((k) => { const [c, r] = k.split(",").map(Number) as [number, number]; return c >= t.x0 && c < t.x0 + t.width && r >= t.y0 && r < t.y0 + t.height; });
    const a = reader(label, () => 1, blank);
    const r = (await floodFill(dims2, [5, 5], 3, a.read)) as FillResult;
    const got = cells(r.spans);
    expect(["255,255", "256,256", "511,300", "512,300", "600,590"].every((k) => got.has(k))).toBe(true);
    expect(got.has("600,599")).toBe(false); // on the raster's last row
    expect(r.pixels).toBe(700 * 600 - 1);
    expect(r.target).toBe(0);
    expect(a.reads).toHaveLength(9);
  });

  it("never fills nodata or a pair holding nodata, even on a seam, and the count excludes them", async () => {
    const dims2 = { width: 512, height: 512 };
    const bad = new Set(["255,100", "300,300", "256,400"]);
    const label: Px = (c, r) => (c === 256 && r === 100 ? 2 : c === 255 && r === 400 ? 2 : 0);
    const valid: Px = (c, r) => (bad.has(`${c},${r}`) ? 0 : 1);
    const r = (await floodFill(dims2, [5, 5], 3, reader(label, valid).read)) as FillResult;
    const got = cells(r.spans);
    expect(["255,100", "256,100", "300,300", "256,400", "255,400"].filter((k) => got.has(k))).toEqual([]);
    expect(r.pixels).toBe(512 * 512 - 5);
  });

  it("a hole pixel already of the value is not counted, but its partner is", async () => {
    const dims2 = { width: 300, height: 300 };
    const label: Px = (c, r) => (r === 50 && c === 50 ? 3 : r === 50 && c === 51 ? 2 : 0);
    const r = (await floodFill(dims2, [5, 5], 3, reader(label).read)) as FillResult;
    const got = cells(r.spans);
    expect([got.has("50,50"), got.has("51,50")]).toEqual([false, true]);
    expect(r.pixels).toBe(300 * 300 - 1);
  });

  it("a region whose every pixel is a diagonal-gap neighbour: a checkerboard of 0 in a 1 field fills only fully enclosed cells", async () => {
    // 5 x 5 checkerboard block of 0s at 100..104: each 0 is 4-surrounded by 1s, but the 1s inside it are cut off from R
    const dims2 = { width: 300, height: 300 };
    const label: Px = (c, r) => (c >= 100 && c <= 104 && r >= 100 && r <= 104 && (c + r) % 2 === 0 ? 0 : 1);
    const r = (await floodFill(dims2, [5, 5], 3, reader(label).read)) as FillResult;
    const got = cells(r.spans);
    // every 1 in the block is 4-connected to R through... nothing: the inner 1s (odd c+r) have all 4 sides 0, so they are not in R
    const zeros: string[] = [], ones: string[] = [];
    for (let y = 100; y <= 104; y++) for (let x = 100; x <= 104; x++) ((x + y) % 2 === 0 ? zeros : ones).push(`${x},${y}`);
    // edge-of-block 1s on the border are in R; 0s on the block's border with all 4 sides in R are holes only if none of their sides is an inner 1
    const want = new Set<string>();
    for (const k of zeros) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      const sidesInR = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].every(([a, b]) => got.has(`${a},${b}`) || !(a! >= 100 && a! <= 104 && b! >= 100 && b! <= 104));
      if (sidesInR) want.add(k);
    }
    expect(zeros.filter((k) => got.has(k)).sort()).toEqual([...want].sort());
    expect(want.size).toBe(4); // the four block corners
    // the 1s cut off inside the block are not in R and are no holes either (every side is a 0 outside R)
    expect(["102,101", "101,102", "103,102", "102,103"].filter((k) => got.has(k))).toEqual([]);
  });
});
