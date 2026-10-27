#!/usr/bin/env node
// Stand-in mangrove-embed chips from public data (ADR 0008). Dev-only; the output is never committed.
// Usage: node scripts/fixtures/standin_chips.mjs <out dir>
// Writes <out>/everglades/chip_NNNN.x.i8 (Int8 [64][128][128], north-up), chip_NNNN.y.u8
// (uint8 [128][128], 1..11, 255 = ignore), index.csv (chip,x0,y1,epsg) and standin.json.
// Then run scripts/fixtures/pack_standin_chips.py <out dir> to write chip_NNNN.npz.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromUrl } from "geotiff";
import proj4 from "proj4";

const AEF_BASE = "https://data.source.coop/tge-labs/aef/v1/annual/";
const WC = (tile) => `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tile}_Map.tif`;
const EPSG = 32617;
const UTM = "+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";
const N = 128, RES = 10, BANDS = 64;
// 2021 AEF COGs over the Everglades, from aef_index.csv (x0, y0, x1, y1 = west, south, east, north).
const COGS = [
  { path: "2021/17N/xmcepcm1cv86qi62y-0000000000-0000000000.tiff", x0: 500000, y0: 2785280, x1: 581920, y1: 2867200 },
  { path: "2021/17N/xfk4o0rlcuy087dyb-0000008192-0000000000.tiff", x0: 500000, y0: 2703360, x1: 581920, y1: 2785280 },
];
// Chip upper-left corners on a 1280 m grid around Whitewater Bay, picked from a WorldCover scan
// for mixed mangrove cover. Northern chips are mostly wetland and mangrove, southern ones mangrove
// and open water, so they alternate: make_aef_fixtures.py's default split (even chips train, odd
// test) then keeps the splits on disjoint chips with a similar class mix.
// AEF has no data only offshore here, so the last chip is open water on the coverage edge.
const col = (i) => 500000 + 1280 * i;
const NORTH = [[5, 2810880], [6, 2808320], [7, 2807040], [9, 2807040], [9, 2805760], [10, 2805760], [11, 2805760], [9, 2804480]];
const SOUTH = [[1, 2801920], [2, 2801920], [3, 2799360], [4, 2799360], [3, 2798080], [4, 2798080], [5, 2796800], [8, 2796800], [9, 2794240]];
const CHIPS = [
  // N0 S0 S1 N1 N2 S2 ...: each split gets northern and southern chips
  ...SOUTH.flatMap((c, k) => (!NORTH[k] ? [c] : k % 2 ? [c, NORTH[k]] : [NORTH[k], c])),
  [2, 2717440], // ~30% no data, for invalid pixels
].map(([i, y1]) => ({ x0: col(i), y1 }));
// WorldCover 10..100 -> mangrove-embed labels 1..11 (mangroves 95 -> 10); anything else -> 255.
const WC_CLASSES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];

const cogs = new Map();
async function cog(path) {
  if (!cogs.has(path)) cogs.set(path, fromUrl(AEF_BASE + path, { blockSize: 65536, cacheSize: 4096 }).then((t) => t.getImage(0)));
  return cogs.get(path);
}

/** Int8 [64][128][128] north-up for the chip with upper-left (x0, y1). */
async function readChip(x0, y1) {
  const e = COGS.find((c) => c.x0 <= x0 && x0 + N * RES <= c.x1 && c.y0 <= y1 - N * RES && y1 <= c.y1);
  if (!e) throw new Error(`chip ${x0},${y1} is not inside one known COG`);
  const image = await cog(e.path);
  const m = image.fileDirectory.getValue("ModelTransformation");
  // Bottom-up when the y scale is positive: row 0 is the southern edge.
  const [gx, sx, gy, sy] = m ? [m[3], m[0], m[7], m[5]] : [image.getOrigin()[0], 10, image.getOrigin()[1], -10];
  if (sx !== RES || Math.abs(sy) !== RES) throw new Error(`${e.path}: unexpected scale ${sx}, ${sy}`);
  const c0 = (x0 - gx) / RES;
  const r0 = sy > 0 ? (y1 - N * RES - gy) / sy : (y1 - gy) / sy;
  const bands = await image.readRasters({ window: [c0, r0, c0 + N, r0 + N] });
  const out = new Int8Array(BANDS * N * N);
  bands.forEach((b, k) => {
    for (let r = 0; r < N; r++) out.set(b.subarray(r * N, (r + 1) * N), k * N * N + (sy > 0 ? N - 1 - r : r) * N);
  });
  return out;
}

const wcTiles = new Map();
async function wcImage(lon, lat) {
  const name = `${lat >= 0 ? "N" : "S"}${String(Math.abs(Math.floor(lat / 3) * 3)).padStart(2, "0")}${lon >= 0 ? "E" : "W"}${String(Math.abs(Math.floor(lon / 3) * 3)).padStart(3, "0")}`;
  if (!wcTiles.has(name)) wcTiles.set(name, fromUrl(WC(name)).then((t) => t.getImage(0)).catch(() => null));
  return wcTiles.get(name);
}

/** uint8 [128][128] labels by nearest WorldCover pixel at each chip pixel centre. */
async function labelChip(x0, y1, x) {
  const toLonLat = proj4(UTM, WGS84);
  const y = new Uint8Array(N * N).fill(255);
  const centres = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) centres.push(toLonLat.forward([x0 + RES * (c + 0.5), y1 - RES * (r + 0.5)]));
  const lons = centres.map((p) => p[0]), lats = centres.map((p) => p[1]);
  const image = await wcImage(Math.min(...lons), Math.min(...lats));
  if (!image || (await wcImage(Math.max(...lons), Math.max(...lats))) !== image) throw new Error(`chip ${x0},${y1} needs one WorldCover tile`);
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const ci = (lon) => Math.floor((lon - ox) / rx), ri = (lat) => Math.floor((lat - oy) / ry);
  const wc0 = Math.max(0, ci(Math.min(...lons))), wr0 = Math.max(0, ri(Math.max(...lats)));
  const wc1 = Math.min(image.getWidth(), ci(Math.max(...lons)) + 1), wr1 = Math.min(image.getHeight(), ri(Math.min(...lats)) + 1);
  const [wc] = await image.readRasters({ window: [wc0, wr0, wc1, wr1] });
  const ww = wc1 - wc0;
  centres.forEach(([lon, lat], i) => {
    const c = ci(lon) - wc0, r = ri(lat) - wr0;
    if (c < 0 || c >= ww || r < 0 || r >= wr1 - wr0) return;
    const k = WC_CLASSES.indexOf(wc[r * ww + c]);
    // AEF no data (-128 in every band) is ignored too
    if (k >= 0 && x[i] !== -128) y[i] = k + 1;
  });
  return y;
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: standin_chips.mjs <out dir>");
  const dir = join(out, "everglades");
  await mkdir(dir, { recursive: true });
  const rows = ["chip,x0,y1,epsg"];
  for (const [n, { x0, y1 }] of CHIPS.entries()) {
    const id = String(n).padStart(4, "0");
    const x = await readChip(x0, y1);
    const y = await labelChip(x0, y1, x);
    await writeFile(join(dir, `chip_${id}.x.i8`), x);
    await writeFile(join(dir, `chip_${id}.y.u8`), y);
    rows.push(`${id},${x0},${y1},${EPSG}`);
    const mangrove = y.filter((v) => v === 10).length, nodata = x.subarray(0, N * N).filter((v) => v === -128).length;
    console.log(`chip_${id} ${x0},${y1}: mangrove ${mangrove}, ignore ${y.filter((v) => v === 255).length}, aef nodata ${nodata}`);
  }
  await writeFile(join(dir, "index.csv"), rows.join("\n") + "\n");
  await writeFile(join(out, "standin.json"), JSON.stringify({ source: "standin", adr: "0008", aef: "2021", labels: "ESA WorldCover 10m 2021 v200" }, null, 2));
}

main().catch((e) => { console.error(`standin_chips: ${e.message}`); process.exit(1); });
