import type { LabelStore } from "../core/labelStore";
import { UndoHistory, type StrokeEdit } from "../io/undoHistory";

type Deps = {
  button: HTMLButtonElement;
  store: () => LabelStore;
  /** Undo must wait: labels locked, a stroke in progress, or stroke cells queued. */
  blocked: () => boolean;
  /** Ctrl+Z is the app's: imagery is open and focus isn't in a text field (which keeps its own undo). */
  shortcut: () => boolean;
  /** An undo restored these tiles. */
  undone: (keys: Iterable<string>) => void;
};

/** Paint undo's wiring (spec 010): one history entry per stroke, the Undo button and Ctrl+Z (Cmd+Z on macOS). */
export function initUndo({ button, store, blocked, shortcut, undone }: Deps) {
  const history = new UndoHistory(store);
  let current: StrokeEdit | null = null;

  // blocked while locked: an export must write the tiles as they were at its click, and a seed builds on the store it started from
  const canUndo = () => history.size > 0 && !blocked();
  const sync = () => { button.disabled = !canUndo(); };
  const undo = () => {
    if (!canUndo()) return;
    const keys = history.undo();
    if (keys) undone(keys);
    sync();
  };

  button.addEventListener("click", undo);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "z" || !(mac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (shortcut()) { e.preventDefault(); undo(); }
  });

  return {
    history,
    /** The stroke in progress, whose cells record into its entry. */
    current: () => current,
    /** A stroke began or ended. */
    stroke(active: boolean): void {
      if (active) current = history.begin();
      else if (current) { history.end(current); current = null; }
      sync();
    },
    /** Update the Undo button after something canUndo reads changed. */
    sync,
    /** Empty the history: new imagery or a replaced store. */
    clear(): void {
      history.clear();
      current = null;
      sync();
    },
  };
}
