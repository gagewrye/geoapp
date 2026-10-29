/** Index of the first element where a and b differ (NaN equals NaN), or -1; cheap on large tiles. */
export function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return i;
  }
  return -1;
}
