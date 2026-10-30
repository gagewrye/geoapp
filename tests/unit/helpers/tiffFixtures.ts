import type { Affine } from "../../../src/core/types";
import type { Value } from "./sources";

/** One IFD: its size, how it is blocked, its band values, and NewSubfileType (1: overview, 4: mask). */
export type FixtureImage = {
  width: number; height: number; bands: number; value: Value;
  /** Tiles of w x h, or strips of `rows` rows. */
  layout: { tile: [number, number] } | { rows: number };
  subfile?: number;
  /** TIFF ExtraSamples (338), e.g. [2] for unassociated alpha (spec 022); none written when absent. */
  extraSamples?: number[];
};

const SHORT = 3, LONG = 4, DOUBLE = 12;
const SIZE: Record<number, number> = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };
type Entry = { tag: number; type: number; values: number[] };

/**
 * Uncompressed 8-bit, pixel-interleaved GeoTIFF with any number of IFDs, tiled or striped (spec 020 fixtures:
 * checkerboard, overviews, single strip). geotiff.js's writer only writes one strip and one IFD. The first IFD is georeferenced.
 */
export function uint8Tiff(images: FixtureImage[], geo: { epsg: number; gt: Affine }): ArrayBuffer {
  const blocks: Uint8Array[][] = images.map(blocksOf);
  let at = 8;
  const offsets = blocks.map((bs) => bs.map((b) => { const o = at; at += b.length + (b.length & 1); return o; }));
  const ifds = images.map((im, i) => entries(im, offsets[i]!, blocks[i]!.map((b) => b.length), i === 0 ? geo : null));
  const ifdAt: number[] = [];
  for (const e of ifds) {
    ifdAt.push(at);
    at += 2 + e.length * 12 + 4;
    for (const x of e) { const n = x.values.length * SIZE[x.type]!; if (n > 4) at += n + (n & 1); }
  }
  const buf = new ArrayBuffer(at), v = new DataView(buf), u8 = new Uint8Array(buf);
  v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, ifdAt[0]!, true);
  blocks.forEach((bs, i) => bs.forEach((b, k) => u8.set(b, offsets[i]![k]!)));
  ifds.forEach((e, i) => {
    let p = ifdAt[i]!, data = p + 2 + e.length * 12 + 4;
    v.setUint16(p, e.length, true);
    for (const x of e) {
      const q = p + 2;
      v.setUint16(q, x.tag, true); v.setUint16(q + 2, x.type, true); v.setUint32(q + 4, x.values.length, true);
      const n = x.values.length * SIZE[x.type]!;
      let w = q + 8;
      if (n > 4) { v.setUint32(w, data, true); w = data; data += n + (n & 1); }
      x.values.forEach((val, j) => {
        const o = w + j * SIZE[x.type]!;
        if (x.type === SHORT) v.setUint16(o, val, true); else if (x.type === LONG) v.setUint32(o, val, true); else v.setFloat64(o, val, true);
      });
      p += 12;
    }
    v.setUint32(ifdAt[i]! + 2 + e.length * 12, ifdAt[i + 1] ?? 0, true);
  });
  return buf;
}

function blocksOf(im: FixtureImage): Uint8Array[] {
  const [bw, bh] = "tile" in im.layout ? im.layout.tile : [im.width, im.layout.rows];
  const tiled = "tile" in im.layout;
  const out: Uint8Array[] = [];
  for (let y0 = 0; y0 < im.height; y0 += bh) for (let x0 = 0; x0 < im.width; x0 += bw) {
    const rows = tiled ? bh : Math.min(bh, im.height - y0);
    const b = new Uint8Array(bw * rows * im.bands);
    for (let r = 0; r < rows; r++) for (let c = 0; c < bw; c++) {
      if (x0 + c >= im.width || y0 + r >= im.height) continue; // tile padding stays 0
      for (let k = 0; k < im.bands; k++) b[(r * bw + c) * im.bands + k] = im.value(k, x0 + c, y0 + r);
    }
    out.push(b);
  }
  return out;
}

function entries(im: FixtureImage, offsets: number[], counts: number[], geo: { epsg: number; gt: Affine } | null): Entry[] {
  const nb = im.bands, e: Entry[] = [];
  if (im.subfile) e.push({ tag: 254, type: LONG, values: [im.subfile] });
  e.push({ tag: 256, type: LONG, values: [im.width] }, { tag: 257, type: LONG, values: [im.height] },
    { tag: 258, type: SHORT, values: Array(nb).fill(8) }, { tag: 259, type: SHORT, values: [1] },
    { tag: 262, type: SHORT, values: [nb - (im.extraSamples?.length ?? 0) === 3 ? 2 : 1] });
  if ("tile" in im.layout) {
    e.push({ tag: 277, type: SHORT, values: [nb] }, { tag: 284, type: SHORT, values: [1] },
      { tag: 322, type: SHORT, values: [im.layout.tile[0]] }, { tag: 323, type: SHORT, values: [im.layout.tile[1]] },
      { tag: 324, type: LONG, values: offsets }, { tag: 325, type: LONG, values: counts });
  } else {
    e.push({ tag: 273, type: LONG, values: offsets }, { tag: 277, type: SHORT, values: [nb] },
      { tag: 278, type: LONG, values: [im.layout.rows] }, { tag: 279, type: LONG, values: counts }, { tag: 284, type: SHORT, values: [1] });
  }
  if (im.extraSamples) e.push({ tag: 338, type: SHORT, values: im.extraSamples });
  e.push({ tag: 339, type: SHORT, values: Array(nb).fill(1) });
  if (geo) {
    const [a, sx, , d, , sy] = geo.gt;
    const keys = geo.epsg === 4326 ? [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326] : [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, geo.epsg];
    e.push({ tag: 33550, type: DOUBLE, values: [sx, -sy, 0] }, { tag: 33922, type: DOUBLE, values: [0, 0, 0, a, d, 0] }, { tag: 34735, type: SHORT, values: keys });
  }
  return e;
}

/** Full image plus overviews at each factor in `factors`, all with the same bands, tiles and value (sampled at k*f). */
export function withOverviews(width: number, height: number, bands: number, value: Value, factors: number[], tile: [number, number] = [256, 256]): FixtureImage[] {
  return [{ width, height, bands, value, layout: { tile } }, ...factors.map((f): FixtureImage => ({
    width: Math.ceil(width / f), height: Math.ceil(height / f), bands, subfile: 1, layout: { tile },
    value: (k, c, r) => value(k, c * f, r * f),
  }))];
}
