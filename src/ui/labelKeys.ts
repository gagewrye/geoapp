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
  /** Spec 046: M chooses Smart (once enabled), Enter applies its mask, and Escape discards its prompt (false: none, so Pan). */
  smart?: { choose(): void; canChoose(): boolean; apply(): boolean; discard(): boolean };
};

/**
 * Single keys to their SHORTCUTS id (specs 039, 045): a KeyboardEvent.key, or a code for keys read by position, such as
 * the peek key left of 1 on US and UK layouts (spec 034). WASD, \, Home and ? are handled by navigation, layout, main
 * and help, and listed here so the help table can be checked against one map.
 */
export const KEYMAP: Record<string, string> = {
  b: "paint", e: "erase", p: "pan", Escape: "pan", Space: "hold-pan", "[": "brush-smaller", "]": "brush-larger",
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), "select-class"])),
  i: "pick", h: "toggle-labels", Backquote: "peek",
  Backslash: "collapse", Home: "home", "?": "help",
  KeyW: "move", KeyA: "move", KeyS: "move", KeyD: "move",
  m: "smart", Enter: "smart-apply", // spec 046; Escape discards a smart prompt before it selects Pan
  f: "fill", // spec 054
};
/** The SHORTCUTS id of a key event: by its key first (so letters follow the layout), else by its code. */
export const actionOf = (e: Pick<KeyboardEvent, "key" | "code">): string | undefined =>
  KEYMAP[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? KEYMAP[e.code];

const MODES: Record<string, BrushMode> = { paint: "paint", erase: "erase", pan: "pan", fill: "fill" };

/** Labelling shortcuts (specs 003, 009, 033, 034, 046, 054): Space holds Pan, [ ] size, 1-9 class, B E P M F Escape mode, H Show labels, ` held peeks, I picks, Enter applies; keys looked up in KEYMAP. */
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
    const a = actionOf(e);
    if (a === "hold-pan") {
      if (!nativeSpace(document.activeElement)) { e.preventDefault(); d.brush.setSpace(true); }
      return;
    }
    if (inTextField(document.activeElement)) return;
    if (a === "peek") { if (!e.repeat && !d.stroking() && d.view.peek(true)) peeking = true; }
    else if (a === "toggle-labels") { if (!e.repeat) d.view.toggle(); }
    else if (a === "pick") d.pick?.();
    else if (a === "brush-smaller") d.size.step(-1);
    else if (a === "brush-larger") d.size.step(1);
    else if (a === "select-class") { if (Number(e.key) <= d.classCount()) d.select(Number(e.key) - 1); }
    else if (a === "smart") { if (!e.repeat && d.smart?.canChoose()) d.smart.choose(); }
    // a focused button takes Enter as its own click
    else if (a === "smart-apply") { if (!(document.activeElement instanceof HTMLButtonElement) && d.smart?.apply()) e.preventDefault(); }
    else if (e.key === "Escape" && d.smart?.discard()) e.preventDefault();
    else {
      const m = a === undefined ? undefined : MODES[a];
      if (m && (m === "pan" || d.canPaint())) d.setMode(m);
    }
  });
  window.addEventListener("keyup", (e) => {
    const a = actionOf(e);
    if (a === "peek") { unpeek(); return; }
    if (a !== "hold-pan") return;
    if (d.open() && !nativeSpace(document.activeElement)) e.preventDefault();
    d.brush.setSpace(false);
  });
}
