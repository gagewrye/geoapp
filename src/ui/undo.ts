import type { LabelStore } from "../core/labelStore";
import { UndoHistory, type StrokeEdit } from "../io/undoHistory";

type Deps = {
  button: HTMLButtonElement;
  redoButton: HTMLButtonElement;
  store: () => LabelStore;
  /** Undo and redo must wait: labels locked, a stroke in progress, or stroke cells queued. */
  blocked: () => boolean;
  /** Ctrl+Z and the redo keys are the app's: imagery is open and focus isn't in a text field (which keeps its own). */
  shortcut: () => boolean;
  /** An undo or redo changed these tiles. */
  undone: (keys: Iterable<string>) => void;
};

/** Paint undo's wiring (specs 010, 037): Undo and Ctrl+Z (Cmd+Z on macOS); Redo, Ctrl+Shift+Z (Cmd+Shift+Z) and Ctrl+Y. */
export function initUndo({ button, redoButton, store, blocked, shortcut, undone }: Deps) {
  const history = new UndoHistory(store);
  let current: StrokeEdit | null = null;

  // blocked while locked: an export must write the tiles as they were at its click, and a seed builds on the store it started from
  const canUndo = () => history.size > 0 && !blocked();
  const canRedo = () => history.redoSize > 0 && !blocked();
  const sync = () => { button.disabled = !canUndo(); redoButton.disabled = !canRedo(); };
  const run = (can: () => boolean, step: () => string[] | null) => () => {
    if (!can()) return;
    const keys = step();
    if (keys) undone(keys);
    sync();
  };
  const undo = run(canUndo, () => history.undo()), redo = run(canRedo, () => history.redo());

  button.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase(), mod = mac ? e.metaKey : e.ctrlKey;
    if (e.altKey) return;
    const act = k === "z" && mod ? (e.shiftKey ? redo : undo) : k === "y" && e.ctrlKey && !e.shiftKey ? redo : null;
    if (act && shortcut()) { e.preventDefault(); act(); }
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
    /** Update the Undo and Redo buttons after something they read changed. */
    sync,
    /** Empty the history: new imagery or a replaced store. */
    clear(): void {
      history.clear();
      current = null;
      sync();
    },
  };
}
