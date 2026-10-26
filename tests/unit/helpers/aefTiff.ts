import { deflateSync } from "node:zlib";

/** Synthetic AEF-like GeoTIFF for tester tests: tiled, band-separate Int8, GDAL_NODATA -128. */
export type AefTiffSpec = {
  width: number; height: number; bands?: number; tile?: number;
  /** Upper-left (north-west) corner in UTM metres. */
  x0: number; y1: number;
  /** Positive y scale with a south-west origin, like Source Cooperative. */
  bottomUp?: boolean;
  epsg?: number; scaleX?: number; scaleY?: number; deflate?: boolean;
  /** Int8 value of band b at north-up row r, column c (file-local). */
  value: (b: number, r: number, c: number) => number;
};

/** Value pattern keyed on global 10 m pixel indices, never -128, so placement errors show. */
export const pattern = (b: number, gx: number, gy: number) => ((((gx * 7 + gy * 13 + b * 31) % 255) + 255) % 255) - 127;

export function aefTiff(s: AefTiffSpec): Uint8Array {
  const nb = s.bands ?? 64, T = s.tile ?? 32, epsg = s.epsg ?? 32617;
  const sx = s.scaleX ?? 10, sy = s.scaleY ?? 10;
  const across = Math.ceil(s.width / T), down = Math.ceil(s.height / T);
  const tiles: Uint8Array[] = [];
  for (let b = 0; b < nb; b++) for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
    const t = new Int8Array(T * T).fill(-128);
    for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
      const fr = ty * T + r, fc = tx * T + c;
      if (fr >= s.height || fc >= s.width) continue;
      const nr = s.bottomUp ? s.height - 1 - fr : fr; // file row -> north-up row
      t[r * T + c] = s.value(b, nr, fc);
    }
    const raw = new Uint8Array(t.buffer);
    tiles.push(s.deflate ? new Uint8Array(deflateSync(raw)) : raw);
  }
  const geo: [number, number, number[]][] = s.bottomUp
    ? [[34264, 12, [sx, 0, 0, s.x0, 0, sy, 0, s.y1 - sy * s.height, 0, 0, 0, 0, 0, 0, 0, 1]]]
    : [[33550, 12, [sx, sy, 0]], [33922, 12, [0, 0, 0, s.x0, s.y1, 0]]];
  const entries: [number, number, number[] | null | string][] = [
    [256, 4, [s.width]], [257, 4, [s.height]], [258, 3, Array(nb).fill(8)], [259, 3, [s.deflate ? 8 : 1]], [262, 3, [1]],
    [277, 3, [nb]], [284, 3, [2]], [322, 3, [T]], [323, 3, [T]], [324, 4, null], [325, 4, tiles.map((t) => t.length)],
    ...(nb > 1 ? [[338, 3, Array(nb - 1).fill(0)] as [number, number, number[]]] : []),
    [339, 3, Array(nb).fill(2)], ...geo,
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg]],
    [42113, 2, "-128\0"],
  ];
  const size: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const count = (v: number[] | null | string) => (v === null ? tiles.length : v.length);
  const dataAt = 8 + 2 + 12 * entries.length + 4;
  let extra = 0;
  for (const [, typ, v] of entries) { const n = count(v) * size[typ]!; if (n > 4) extra += (n + 1) & ~1; }
  const offsets: number[] = [];
  let at = dataAt + extra;
  for (const t of tiles) { offsets.push(at); at += t.length; }
  const out = new Uint8Array(at);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49]); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  let p = 10, blob = dataAt;
  const put = (typ: number, v: number[] | string, o: number) => {
    if (typeof v === "string") { for (let i = 0; i < v.length; i++) out[o + i] = v.charCodeAt(i); return; }
    v.forEach((x, i) => {
      const q = o + i * size[typ]!;
      if (typ === 3) dv.setUint16(q, x, true); else if (typ === 4) dv.setUint32(q, x, true); else dv.setFloat64(q, x, true);
    });
  };
  for (const [tag, typ, v0] of entries) {
    const v = v0 === null ? offsets : v0;
    const n = count(v), bytes = n * size[typ]!;
    dv.setUint16(p, tag, true); dv.setUint16(p + 2, typ, true); dv.setUint32(p + 4, n, true);
    if (bytes <= 4) put(typ, v, p + 8);
    else { dv.setUint32(p + 8, blob, true); put(typ, v, blob); blob += (bytes + 1) & ~1; }
    p += 12;
  }
  dv.setUint32(p, 0, true);
  tiles.forEach((t, i) => out.set(t, offsets[i]!));
  return out;
}

export type Served = { url: string; range: [number, number] | null };
/** Per request: return a Response to override, or undefined to serve the bytes with a correct 206. */
export type Override = (url: string, range: [number, number] | null, data: Uint8Array) => Response | "network" | undefined;

/** Fake fetch serving in-memory files by URL with 206 and Content-Range; logs every request. */
export function memFetch(files: Map<string, Uint8Array>, override: Override = () => undefined) {
  const log: Served[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const h = new Headers(init.headers).get("range") ?? "";
    const m = /^bytes=(\d+)-(\d+)$/.exec(h);
    const range: [number, number] | null = m ? [Number(m[1]), Number(m[2])] : null;
    log.push({ url, range });
    const data = files.get(url);
    if (!data) return new Response("not found", { status: 404 });
    const o = override(url, range, data);
    if (o === "network") throw new TypeError("Failed to fetch");
    if (o) return o;
    if (!range) return new Response(data.slice(), { status: 200 });
    const end = Math.min(range[1], data.length - 1);
    return new Response(data.slice(range[0], end + 1), { status: 206, headers: { "Content-Range": `bytes ${range[0]}-${end}/${data.length}` } });
  };
  return { fetch: fetch as typeof globalThis.fetch, log };
}
