import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { brush, brushSpans, emptyStore, putTile, type LabelStore } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { windowSpans } from "../../../src/core/spans";
import { makeTile } from "../helpers/tiles";

// Spec 048 criterion 1: no tile cap. 1,024 tiles stored, plus a 33rd tile row for the 1,025th
// (an exactly 8,192² raster has only 1,024 tile windows).
const W = 8192, H = 8192 + 256;

function full(): LabelStore {
  const s = emptyStore(W, H);
  for (const w of tileWindows(W, 8192)) s.tiles.set(`${w.x0},${w.y0}`, new Uint8Array(65536).fill(1));
  expect(s.tiles.size).toBe(1024);
  return s;
}
const KEY = "0,8192", DAB = { x0: 10, y0: 8192 + 10, width: 7, height: 7 };
const masks = () => new Map([[KEY, nodataMask(makeTile(0, 8192, 256, 256, 1, () => 1))]]);

describe("no label tile cap (spec 048 criterion 1)", () => {
  it("brush creates a 1,025th tile", () => {
    const s = full();
    brush(s, masks(), DAB, 2, false);
    expect(s.tiles.size).toBe(1025);
    expect(s.tiles.get(KEY)![10 * 256 + 10]).toBe(2);
  });

  it("brushSpans creates a 1,025th tile", () => {
    const s = full();
    brushSpans(s, masks(), windowSpans(DAB), 2, false);
    expect(s.tiles.size).toBe(1025);
    expect(s.tiles.get(KEY)![16 * 256 + 16]).toBe(2);
  });

  it("putTile creates a 1,025th tile", () => {
    const s = full();
    const t = new Uint8Array(65536).fill(3);
    putTile(s, { x0: 0, y0: 8192, width: 256, height: 256 }, t);
    expect(s.tiles.size).toBe(1025);
    expect(s.tiles.get(KEY)).toBe(t);
  });

  it("src/ names no MAX_LABEL_TILES, labelLimit or editLimit", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
    const hits = files("src").filter((p) => /\.(ts|css|html)$/.test(p) && /MAX_LABEL_TILES|labelLimit|editLimit/.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
});
