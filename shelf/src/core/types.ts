// Fragment of src/core/types.ts (spec 013): merge these back by hand.
/** Shared core types and constants (spec 001). */
export const EPS = 1e-6;

export type Model = {
  version: 1;
  type: "logreg";
  bands: number[];
  mean: number[];
  std: number[];
  classes: string[];
  W: number[][];
  b: number[];
};
