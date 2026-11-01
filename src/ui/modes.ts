import type { BrushMode, createBrush } from "../map/brush";
import { deferMode } from "./deferMode";
import type { initLabelView } from "./labelView";

const MODES: BrushMode[] = ["paint", "erase", "pan", "smart"];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Deps = {
  brush: Pick<ReturnType<typeof createBrush>, "setMode" | "stroking" | "setBlocked">;
  view: Pick<ReturnType<typeof initLabelView>, "show" | "peek" | "peeking">;
  /** The mode changed (spec 032's status bar). */
  toolChanged: () => void;
  /** The Smart button was clicked: Smart is selected once its model loads (spec 046). */
  smart: () => void;
};

/** The Pan, Paint, Erase and Smart buttons, mode keys held to a stroke's end, and the peek's brush block (specs 016, 033, 034, 046). */
export function initModes({ brush, view, toolChanged, smart }: Deps) {
  let mode: BrushMode = "pan";
  let noSmart = false; // no WebGPU: Smart stays off for this page's life
  const setMode = (m: BrushMode) => {
    keyed.clear();
    mode = m;
    brush.setMode(m);
    toolChanged();
    for (const b of MODES) $(`mode-${b}`).setAttribute("aria-pressed", String(m === b));
  };
  // Paint, Erase and Smart never apply to labels you can't see (specs 016, 033, 046): hiding selects Pan, and each shows them first
  const choose = (m: BrushMode) => { if (m !== "pan") view.show(); setMode(m); };
  const keyed = deferMode(() => brush.stroking(), choose);
  for (const m of MODES) $(`mode-${m}`).addEventListener("click", () => (m === "smart" ? smart() : choose(m)));
  const smartButton = $<HTMLButtonElement>("mode-smart");

  return {
    mode: () => mode,
    setMode,
    /** A mode key: applies now, or when the stroke in progress ends. */
    request: keyed.request,
    strokeEnded: keyed.strokeEnded,
    /** Drops a queued mode key (a raster opening ends the stroke it waits for: spec 034). */
    clearQueued: keyed.clear,
    /** Paint, Erase and Smart are offered only once the imagery is drawn (spec 019). */
    ready(on: boolean): void {
      $<HTMLButtonElement>("mode-paint").disabled = $<HTMLButtonElement>("mode-erase").disabled = !on;
      smartButton.disabled = !on || noSmart;
    },
    canPaint: () => !$<HTMLButtonElement>("mode-paint").disabled,
    canSmart: () => !smartButton.disabled,
    /** Smart can't run here (spec 046 scope 1): its button stays disabled, and its title says why. */
    smartOff(why: string): void { noSmart = true; smartButton.disabled = true; smartButton.title = why; },
    /** A peek hides the labels, so no stroke starts under it (spec 034). */
    peek(on: boolean): boolean {
      const changed = view.peek(on);
      brush.setBlocked(view.peeking());
      return changed;
    },
  };
}
