// Fragment of src/core/labelStore.ts (spec 013): merge back by hand, beside origin and tileWindow; Train uses these.
/** Windows of the stored tiles, row-major. */
export function labelWindows(store: LabelStore): Window[] {
  return [...store.tiles.keys()].map(origin).sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([x, y]) => tileWindow(store, x, y));
}

/** Label values present in the store. */
export function paintedValues(store: LabelStore): Set<number> {
  const seen = new Set<number>();
  for (const tile of store.tiles.values()) for (const v of tile) if (v) seen.add(v);
  return seen;
}

/** Classes of a classCount-long list with labelled pixels; a value with no class doesn't count. */
// Imports and seeds write the store too (spec 004), so Train doesn't rely on the brush's values alone.
export function paintedClasses(store: LabelStore, classCount: number): number {
  return [...paintedValues(store)].filter((v) => v <= classCount).length;
}
