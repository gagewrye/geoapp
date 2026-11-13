import type { Affine } from "../../../src/core/types";
import type { Value } from "./sources";

/** In-memory tiled GeoTIFF (Float32, or Uint8 with uint8; pixel-interleaved, uncompressed), like geotiffBuffer but in side x side tiles (spec 072's cheap fixtures). */
// geotiff.js writes strips only; this writes the same tags as geotiffBuffer plus TileWidth, TileLength, TileOffsets and TileByteCounts.
export function tiledGeotiffBuffer(width: number, height: number, nb: number, f: Value, geo: { epsg: number; gt: Affine; nodata?: string }, { side = 256, uint8 = false } = {}): ArrayBuffer {
  const bytes = uint8 ? 1 : 4;
  const across = Math.ceil(width / side), down = Math.ceil(height / side), tiles = across * down, tileBytes = side * side * nb * bytes;
  const [a, sx, , d, , sy] = geo.gt;
  const keys = geo.epsg === 4326 ? [1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326] : [1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, geo.epsg];
  const SHORT = 3, LONG = 4, ASCII = 2, DOUBLE = 12, size: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const tags: [number, number, number[] | string][] = [
    [256, LONG, [width]], [257, LONG, [height]], [258, SHORT, Array(nb).fill(8 * bytes)], [259, SHORT, [1]],
    [262, SHORT, [nb >= 3 ? 2 : 1]], [277, SHORT, [nb]], [284, SHORT, [1]], [322, SHORT, [side]], [323, SHORT, [side]],
    [324, LONG, Array(tiles).fill(0)], [325, LONG, Array(tiles).fill(tileBytes)], [339, SHORT, Array(nb).fill(uint8 ? 1 : 3)],
    [33550, DOUBLE, [sx, -sy, 0]], [33922, DOUBLE, [0, 0, 0, a, d, 0]], [34735, SHORT, [1, 1, 0, keys.length / 4, ...keys]],
    ...(geo.nodata ? [[42113, ASCII, geo.nodata] as [number, number, string]] : []),
  ];
  const n = (v: number[] | string) => (typeof v === "string" ? v.length + 1 : v.length);
  const ifd = 8, extraAt = ifd + 2 + tags.length * 12 + 4;
  let extra = 0;
  for (const [, t, v] of tags) if (n(v) * size[t]! > 4) extra += (n(v) * size[t]! + 1) & ~1;
  const first = (extraAt + extra + 3) & ~3; // Float32Array needs 4-byte alignment
  const buf = new ArrayBuffer(first + tiles * tileBytes), dv = new DataView(buf);
  (tags.find((t) => t[0] === 324)![2] as number[]).forEach((_, i, o) => { o[i] = first + i * tileBytes; });
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifd, true); dv.setUint16(ifd, tags.length, true);
  let at = extraAt;
  tags.forEach(([tag, type, v], i) => {
    const p = ifd + 2 + i * 12, len = n(v) * size[type]!;
    dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, n(v), true);
    let w = p + 8;
    if (len > 4) { dv.setUint32(w, at, true); w = at; at += (len + 1) & ~1; }
    if (typeof v === "string") for (let k = 0; k < v.length; k++) dv.setUint8(w + k, v.charCodeAt(k));
    else v.forEach((x, k) => (type === SHORT ? dv.setUint16(w + 2 * k, x, true) : type === LONG ? dv.setUint32(w + 4 * k, x, true) : dv.setFloat64(w + 8 * k, x, true)));
  });
  const px = uint8 ? new Uint8Array(buf, first) : new Float32Array(buf, first);
  for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
    const o = (ty * across + tx) * side * side * nb;
    for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) {
      const col = tx * side + c, row = ty * side + r;
      if (col < width && row < height) for (let b = 0; b < nb; b++) px[o + (r * side + c) * nb + b] = f(b, col, row);
    }
  }
  return buf;
}
