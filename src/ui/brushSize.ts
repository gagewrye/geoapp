import { DEFAULT_BRUSH, stepBrush } from "../core/pixel";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The brush size controls (spec 017): the slider, its text and the −/+ buttons; index.html holds the slider's range. */
export function initBrushSize(changed: () => void) {
  const text = $("brush-size"), range = $<HTMLInputElement>("brush-size-range");
  let size = DEFAULT_BRUSH; // kept when another raster opens

  const set = (side: number) => {
    size = side;
    range.value = String(side);
    text.textContent = `Brush: ${side} px`;
    changed(); // the footprint redraws at once; a stroke in progress uses it from its next cell
  };
  const step = (d: 1 | -1) => set(stepBrush(size, d));
  set(size); // a reload starts at the default even where the browser restores form values
  range.addEventListener("input", () => set(Number(range.value))); // live while dragging
  $("brush-smaller").addEventListener("click", () => step(-1));
  $("brush-larger").addEventListener("click", () => step(1));

  return {
    side: () => size,
    /** `[`/`]`: halve or double the size (stepBrush). */
    step,
  };
}
