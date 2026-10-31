import type { BrushMode, createBrush } from "../map/brush";
import type { initBrushSize } from "./brushSize";

const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "color", "file", "range", "image"]);
/** Focus is in a field that takes typed text, where keys aren't shortcuts. */
export const inTextField = (el: Element | null) => el instanceof HTMLTextAreaElement
  || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

type Deps = {
  /** Imagery is open, so the shortcuts apply. */
  open: () => boolean;
  brush: Pick<ReturnType<typeof createBrush>, "setSpace">;
  size: Pick<ReturnType<typeof initBrushSize>, "step">;
  select: (i: number) => void;
  classCount: () => number;
  setMode: (m: BrushMode) => void;
  /** The Paint (and Erase) button is enabled (spec 019). */
  canPaint: () => boolean;
};

const MODE_KEYS: Record<string, BrushMode> = { b: "paint", e: "erase", p: "pan", escape: "pan" };

/** Labelling shortcuts (specs 003, 009, 033): Space holds Pan, [ and ] size the brush, 1-9 pick a class, B, E, P and Escape pick a mode. */
export function initLabelKeys(d: Deps): void {
  // Chromium marks the focused element :focus-visible on any keydown, so how it got focus is read when focus arrives
  let keyFocused = false;
  window.addEventListener("focusin", (e) => { keyFocused = e.target instanceof Element && e.target.matches(":focus-visible"); });
  window.addEventListener("pointerdown", () => { keyFocused = false; }, true);
  // Keyboard users press a control they tabbed to with Space; a mouse click leaves focus there, and then Space means Pan
  const nativeSpace = (el: Element | null) => inTextField(el) || el instanceof HTMLSelectElement
    || (keyFocused && (el instanceof HTMLButtonElement || el instanceof HTMLInputElement));
  window.addEventListener("keydown", (e) => {
    if (!d.open() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") {
      if (!nativeSpace(document.activeElement)) { e.preventDefault(); d.brush.setSpace(true); }
      return;
    }
    if (inTextField(document.activeElement)) return;
    if (e.key === "[") d.size.step(-1);
    else if (e.key === "]") d.size.step(1);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= d.classCount()) d.select(Number(e.key) - 1);
    else {
      const m = MODE_KEYS[e.key.toLowerCase()];
      if (m && (m === "pan" || d.canPaint())) d.setMode(m);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    if (d.open() && !nativeSpace(document.activeElement)) e.preventDefault();
    d.brush.setSpace(false);
  });
}
