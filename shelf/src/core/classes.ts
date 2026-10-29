// Fragment of src/core/classes.ts (spec 013): merge back by hand, beside checkName; seedModel's name check uses it.

/** Index of the first name spec 003's rule refuses as it stands (empty, duplicated or untrimmed), else null. */
export function badClassName(names: string[]): number | null {
  const list = names.map((name) => ({ name }));
  const i = names.findIndex((name, j) => checkName(list, j, name) !== name);
  return i < 0 ? null : i;
}
