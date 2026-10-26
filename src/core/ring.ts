import { MAX_LAT } from "./types";

/** Why a lon/lat ring is blocked in v1, or null when it is allowed. */
export function checkRing(ring: [number, number][]): "antimeridian" | "latitude" | null {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (Math.abs(b[0] - a[0]) > 180) return "antimeridian";
  }
  for (const [, lat] of ring) if (Math.abs(lat) > MAX_LAT) return "latitude";
  return null;
}

/** Wrap a longitude into [-180, 180]; MapLibre world copies can unproject beyond it. */
export function normalizeLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
