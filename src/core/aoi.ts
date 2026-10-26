import { AEF_RES, MAX_AOI_SIDE, type AefEntry, type Aoi } from "./aef";
import { fromLonLat } from "./crs";

/** WGS84 UTM EPSG code: 326zz north of (and on) the equator, else 327zz; lon 180 is zone 60. */
export function utmEpsg(lon: number, lat: number): number {
  const zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
  return (lat >= 0 ? 32600 : 32700) + zone;
}

// Edges of a lon/lat rectangle bow in UTM, so the bbox is taken over densified edges.
const EDGE_STEPS = 16;

/** Lon/lat ring (closed or open) to a north-up 10 m UTM grid snapped outward; "zones" or "size" when refused. */
export function aoiGrid(ring: [number, number][]): Aoi | "zones" | "size" {
  const epsgs = new Set(ring.map(([lon, lat]) => utmEpsg(lon, lat)));
  if (epsgs.size !== 1) return "zones";
  const epsg = [...epsgs][0]!;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    for (let s = 0; s < EDGE_STEPS; s++) {
      const t = s / EDGE_STEPS;
      const [x, y] = fromLonLat(epsg, ax + (bx - ax) * t, ay + (by - ay) * t);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const gx0 = Math.floor(x0 / AEF_RES) * AEF_RES, gy1 = Math.ceil(y1 / AEF_RES) * AEF_RES;
  const width = Math.max(1, Math.ceil(x1 / AEF_RES) - gx0 / AEF_RES);
  const height = Math.max(1, gy1 / AEF_RES - Math.floor(y0 / AEF_RES));
  if (width > MAX_AOI_SIDE || height > MAX_AOI_SIDE) return "size";
  return { epsg, gt: [gx0, AEF_RES, 0, gy1, 0, -AEF_RES], width, height };
}

/** Entries of the year and zone whose bounds overlap the AOI with positive area (touching is not enough). */
export function selectEntries(index: AefEntry[], aoi: Aoi, year: number): AefEntry[] {
  const ax0 = aoi.gt[0], ay1 = aoi.gt[3];
  const ax1 = ax0 + aoi.gt[1] * aoi.width, ay0 = ay1 + aoi.gt[5] * aoi.height;
  // the overlap is [max(x0), min(x1)] x [max(y0), min(y1)]; both sides must be positive
  return index.filter((e) => e.year === year && e.epsg === aoi.epsg
    && Math.max(e.x0, ax0) < Math.min(e.x1, ax1) && Math.max(e.y0, ay0) < Math.min(e.y1, ay1));
}
