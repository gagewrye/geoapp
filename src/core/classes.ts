/** A label class; its label value is its list index + 1. */
export type LabelClass = { name: string; colour: string }; // colour "#rrggbb"

/** Label values are 1..255 in a Uint8 tile, so 255 classes at most. */
export const MAX_CLASSES = 255;

/** Fixed 10-colour palette, cycled by list position. */
export const PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#7f7f7f"] as const;

export const paletteColour = (index: number): string => PALETTE[index % PALETTE.length]!;

export const initialClasses = (): LabelClass[] => [{ name: "Class 1", colour: paletteColour(0) }, { name: "Class 2", colour: paletteColour(1) }];

/** The class Add appends: "Class N" for the first unused N from the list length + 1, palette colour by position. */
export function nextClass(list: LabelClass[]): LabelClass {
  let n = list.length + 1;
  while (list.some((c) => c.name === `Class ${n}`)) n++;
  return { name: `Class ${n}`, colour: paletteColour(list.length) };
}

/** The trimmed name if class `index` may take it: not empty and no other class's name; else null. */
export function checkName(list: { name: string }[], index: number, name: string): string | null {
  const t = name.trim();
  if (!t || list.some((c, i) => i !== index && c.name === t)) return null;
  return t;
}
