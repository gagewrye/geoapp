import proj4 from "proj4";
import type { Affine } from "./types";

const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";
const MERC_HALF = Math.PI * 6378137; // 3857 x at lon 180

/** Locally built proj strings (ADR 0002): no network lookup. */
export function projString(epsg: number): string {
  if (epsg === 4326) return WGS84;
  if (epsg === 3857) return "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs";
  const zone = epsg % 100;
  if ((epsg - zone === 32600 || epsg - zone === 32700) && zone >= 1 && zone <= 60) {
    return `+proj=utm +zone=${zone}${epsg >= 32700 ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  }
  throw new Error(`Unsupported CRS EPSG:${epsg} (v1 supports 4326, 3857 and WGS84 UTM)`);
}

/** Central meridian used to unwrap longitudes, so UTM zone 60 can pass 180. */
function centralLon(epsg: number): number {
  return epsg === 4326 || epsg === 3857 ? 0 : -183 + 6 * (epsg % 100);
}

const converters = new Map<number, proj4.Converter>();
function converter(epsg: number): proj4.Converter {
  let c = converters.get(epsg);
  if (!c) {
    c = proj4(WGS84, projString(epsg));
    converters.set(epsg, c);
  }
  return c;
}

/** CRS coordinates to lon/lat, longitude kept within 180 of the CRS central meridian. */
export function toLonLat(epsg: number, x: number, y: number): [number, number] {
  if (epsg === 4326) return [x, y];
  const [lon, lat] = converter(epsg).inverse([x, y]) as [number, number];
  const c = centralLon(epsg);
  return [lon - 360 * Math.round((lon - c) / 360), lat];
}

/** Lon/lat to CRS coordinates. */
export function fromLonLat(epsg: number, lon: number, lat: number): [number, number] {
  if (epsg === 4326) return [lon, lat];
  return converter(epsg).forward([lon, lat]) as [number, number];
}

export function applyAffine(gt: Affine, col: number, row: number): [number, number] {
  return [gt[0] + gt[1] * col + gt[2] * row, gt[3] + gt[4] * col + gt[5] * row];
}

export function invertAffine(gt: Affine, x: number, y: number): [number, number] {
  const det = gt[1] * gt[5] - gt[2] * gt[4];
  const dx = x - gt[0];
  const dy = y - gt[3];
  return [(gt[5] * dx - gt[2] * dy) / det, (-gt[4] * dx + gt[1] * dy) / det];
}

/** True when a 4326/3857 raster's corner extent goes past +-180 longitude (v1 refuses these). */
export function crossesAntimeridian(epsg: number, gt: Affine, width: number, height: number): boolean {
  projString(epsg);
  if (epsg !== 4326 && epsg !== 3857) return false;
  const limit = epsg === 4326 ? 180 : MERC_HALF;
  const tol = limit * 1e-12; // an edge exactly at 180 must survive float rounding
  for (const [c, r] of [[0, 0], [width, 0], [0, height], [width, height]] as const) {
    if (Math.abs(applyAffine(gt, c, r)[0]) > limit + tol) return true;
  }
  return false;
}

/** Wrap a longitude into [-180, 180]; MapLibre world copies can unproject beyond it. */
export function normalizeLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
