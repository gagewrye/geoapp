type Pt = [number, number];

/**
 * True when a select-mode press at p drags the polygon body: terra-draw prefers any vertex or
 * midpoint within grabPx (its pointerDistance), else drags the body if p is inside (screen px).
 */
export function grabsBody(ring: Pt[], midpoints: Pt[], p: Pt, grabPx: number): boolean {
  const near = (q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]) < grabPx;
  if (ring.some(near) || midpoints.some(near)) return false;
  const closed = ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1];
  const n = closed ? ring.length - 1 : ring.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** True when shifting a lon/lat ring by dLon puts a vertex past +-180, which terra-draw drops unvalidated. */
export function translatedPastAntimeridian(ring: Pt[], dLon: number): boolean {
  return ring.some(([lon]) => Math.abs(lon + dLon) > 180);
}
