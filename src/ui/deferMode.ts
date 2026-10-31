import type { BrushMode } from "../map/brush";

/** A mode key pressed during a stroke takes effect when the stroke ends (spec 033 scope 4); the last one pressed wins. */
export function deferMode(stroking: () => boolean, choose: (m: BrushMode) => void) {
  let pending: BrushMode | null = null;
  return {
    request(m: BrushMode): void { if (stroking()) pending = m; else choose(m); },
    /** Call when a stroke ends. */
    strokeEnded(): void {
      const m = pending;
      pending = null;
      if (m) choose(m);
    },
    /** Another mode change (open, import, hiding labels) overrides a key still waiting. */
    clear(): void { pending = null; },
  };
}
