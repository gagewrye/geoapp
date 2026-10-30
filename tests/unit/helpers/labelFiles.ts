import { writeArrayBuffer } from "geotiff";
import { encodeClasses } from "../../../src/core/classTable";
import type { ClassEntry } from "../../../src/core/classTable";
import type { Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import { writeTiff } from "../../../src/io/tiffWriter";

/**
 * Spec 004's test class rasters: EPSG:32633 at 2 km over spec 001's EPSG:4326 fixture (rgbFixture,
 * 10..20E 40..50N), about 11.9..18.1E and 43.3..46.9N, so every pixel lies on the imagery. Each is
 * under 100 KB and is generated here rather than committed.
 */
export const CLASS_GRID: Grid = { width: 240, height: 200, epsg: 32633, gt: [260000, 2000, 0, 5200000, 0, -2000] };
const CLASS_VALUES = [0, 3, 7, 255];
/** 0, 3, 7 and 255 in 24 x 20 px blocks. */
export const classValue = (c: number, r: number) => CLASS_VALUES[(Math.floor(c / 24) + Math.floor(r / 20)) % 4]!;

const UTM_KEYS = { GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32633 };
const geoMeta = (g: Grid) => ({ ModelPixelScale: [g.gt[1], -g.gt[5], 0], ModelTiepoint: [0, 0, 0, g.gt[0], g.gt[3], 0] });

/** A strip GeoTIFF written by geotiff.js (an independent writer): nb pixel-interleaved bands of `values`' type. */
export function writeFile(g: Grid, nb: number, values: Uint8Array | Uint16Array | Int8Array, nodata?: string, keys: Record<string, number> = UTM_KEYS): ArrayBuffer {
  return writeArrayBuffer(values, { width: g.width, height: g.height, SamplesPerPixel: nb, ...geoMeta(g), ...keys, ...(nodata === undefined ? {} : { GDAL_NODATA: nodata }) });
}

/** The single-band Uint8 class raster, f(c, r) per pixel (default classValue); null writes no GDAL_NODATA. */
export function classFile(nodata: string | null = "255", g: Grid = CLASS_GRID, f: (c: number, r: number) => number = classValue): ArrayBuffer {
  const v = new Uint8Array(g.width * g.height);
  for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) v[r * g.width + c] = f(c, r);
  return writeFile(g, 1, v, nodata ?? undefined);
}

/** The class map fixture: names (and one colour) for 3 and 7; 0 is unlisted. */
export const CLASS_MAP: ClassEntry[] = [{ value: 7, name: "Seven", colour: "#123456" }, { value: 3, name: "Three" }];

/** CLASS_ITEM fixture entries: GDAL_METADATA from encodeClasses, value = index + 1. */
export const ITEM_CLASSES = [{ name: "Zero", colour: "#aa0000" }, { name: "Mangrove & <salt>", colour: "#00bb00" }, { name: "Water", colour: "#0000cc" }];
/** With CLASS_ITEM: values 1, 2, 3 (ITEM_CLASSES) and 0 for unlabelled, nodata "0"; written with ADR 0001's writer, which can write GDAL_METADATA. */
export async function classItemFile(): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const g = CLASS_GRID;
  const geo = { GeoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32633], ...geoMeta(g) };
  const remap: Record<number, number> = { 0: 0, 3: 1, 7: 2, 255: 3 };
  await writeTiff({ write: async (d) => { parts.push(d.slice()); }, close: async () => {} }, g.width, g.height, geo, async (w) => {
    const t = new Uint8Array(w.width * w.height);
    for (let r = 0; r < w.height; r++) for (let c = 0; c < w.width; c++) t[r * w.width + c] = remap[classValue(w.x0 + c, w.y0 + r)]!;
    return t;
  }, { nodata: "0", metadata: encodeClasses(ITEM_CLASSES) });
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

/** Refusal fixtures: 3-band Uint8 and single-band Uint16, on CLASS_GRID. */
export const rgbClassFile = () => writeFile(CLASS_GRID, 3, new Uint8Array(CLASS_GRID.width * CLASS_GRID.height * 3).fill(3));
export const uint16ClassFile = () => writeFile(CLASS_GRID, 1, new Uint16Array(CLASS_GRID.width * CLASS_GRID.height).fill(3));

/** AlphaEarth's layout (spec 013 criterion 8): 64 Int8 bands, GDAL_NODATA -128 at pixel (0, 0), 32 x 32 px at CLASS_GRID's origin. */
export function aefShapedFile(): ArrayBuffer {
  const g: Grid = { ...CLASS_GRID, width: 32, height: 32 };
  const v = new Int8Array(g.width * g.height * 64);
  for (let i = 0; i < v.length; i++) v[i] = i < 64 ? -128 : ((i % 64) * 7 + Math.floor(i / 64)) % 200 - 100;
  return writeFile(g, 64, v, "-128");
}

/** A class raster computed on demand (for rasters too large to write), logging every window read. */
export function fakeLabelSource(g: Grid, f: (c: number, r: number) => number, nodata: number | null = null) {
  const reads: { x0: number; y0: number; width: number; height: number }[] = [];
  const source: LabelSource = {
    meta: { ...g, bandCount: 1, nodata, float: false, geoTags: { GeoKeyDirectory: [] } },
    classItem: null,
    async read(w) {
      reads.push({ ...w });
      const out = new Uint8Array(w.width * w.height);
      for (let r = 0; r < w.height; r++) for (let c = 0; c < w.width; c++) out[r * w.width + c] = f(w.x0 + c, w.y0 + r);
      return out;
    },
  };
  return { source, reads };
}
