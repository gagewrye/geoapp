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
