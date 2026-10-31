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
  /** A stroke is in progress: a peek doesn't start. */
  stroking: () => boolean;
  /** peek returns true when the call changed the peek state. */
  view: { toggle(): void; peek(on: boolean): boolean };
  /** Picks the class under the pointer (spec 038), if it is over the raster. */
  pick?: () => void;
};

// The key left of 1 on US and UK layouts, by position so other layouts still have it (spec 034)
const PEEK = "Backquote";

const MODE_KEYS: Record<string, BrushMode> = { b: "paint", e: "erase", p: "pan", escape: "pan" };

/** Labelling shortcuts (specs 003, 009, 033, 034): Space holds Pan, [ ] size, 1-9 class, B E P Escape mode, H Show labels, ` held peeks, I picks. */
export function initLabelKeys(d: Deps): void {
  // Chromium marks the focused element :focus-visible on any keydown, so how it got focus is read when focus arrives
  let keyFocused = false;
  window.addEventListener("focusin", (e) => { keyFocused = e.target instanceof Element && e.target.matches(":focus-visible"); });
  window.addEventListener("pointerdown", () => { keyFocused = false; }, true);
  // Keyboard users press a control they tabbed to with Space; a mouse click leaves focus there, and then Space means Pan
  const nativeSpace = (el: Element | null) => inTextField(el) || el instanceof HTMLSelectElement
    || (keyFocused && (el instanceof HTMLButtonElement || el instanceof HTMLInputElement));
  // Only a peek this started ends on keyup; a lost keyup (focus left the window) ends it on blur
  let peeking = false;
  const unpeek = () => { if (peeking) { peeking = false; d.view.peek(false); } };
  window.addEventListener("blur", unpeek);
  window.addEventListener("keydown", (e) => {
    if (!d.open() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") {
      if (!nativeSpace(document.activeElement)) { e.preventDefault(); d.brush.setSpace(true); }
      return;
    }
    if (inTextField(document.activeElement)) return;
    if (e.code === PEEK) { if (!e.repeat && !d.stroking() && d.view.peek(true)) peeking = true; return; }
    if (e.key.toLowerCase() === "h") { if (!e.repeat) d.view.toggle(); return; }
    if (e.key.toLowerCase() === "i") { d.pick?.(); return; }
    if (e.key === "[") d.size.step(-1);
    else if (e.key === "]") d.size.step(1);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= d.classCount()) d.select(Number(e.key) - 1);
    else {
      const m = MODE_KEYS[e.key.toLowerCase()];
      if (m && (m === "pan" || d.canPaint())) d.setMode(m);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === PEEK) { unpeek(); return; }
    if (e.code !== "Space") return;
    if (d.open() && !nativeSpace(document.activeElement)) e.preventDefault();
    d.brush.setSpace(false);
  });
}
