import type { Map as MapLibreMap } from "maplibre-gl";
import { MAX_CLASSES, checkName, initialClasses, nextClass, type LabelClass } from "../core/classes";
import type { Window } from "../core/grid";
import { emptyStore, keepMasks, paintedClasses, tileKeys, type LabelStore } from "../core/labelStore";
import { BRUSH_SIZES, DEFAULT_BRUSH } from "../core/pixel";
import { PaintQueue } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import { UndoHistory, type StrokeEdit } from "../io/undoHistory";
import { createBrush, type BrushMode } from "../map/brush";
import { LabelOverlays } from "../map/labelOverlay";
import { markSelected, renderClasses } from "./classList";
import { MESSAGES } from "./messages";

type Deps = {
  map: MapLibreMap;
  say: (text: string) => void;
  /** The paint queue became busy or idle (Train is disabled while it is busy). */
  onBusy: () => void;
  /** The store changed: a cell applied, labels were replaced, or new imagery opened. */
  onChange: () => void;
  /** Paint mode was chosen: the AlphaEarth area tool must stop (ADR 0009). */
  onPaint: () => void;
  /** A middle-button pan is in progress (spec 009). */
  panning: () => boolean;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "color", "file", "range", "image"]);
export const inTextField = (el: Element | null) => el instanceof HTMLTextAreaElement
  || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

/** Brush labels on local imagery (spec 003): panel, classes, shortcuts, store, paint queue and overlays. */
export function initLabels({ map, say, onBusy, onChange, onPaint, panning }: Deps) {
  const panel = $("brush-panel"), list = $("classes"), add = $<HTMLButtonElement>("class-add"), sizeText = $("brush-size");
  const undoButton = $<HTMLButtonElement>("undo");
  const classes: LabelClass[] = initialClasses();
  let selected = 0;
  let size = BRUSH_SIZES.indexOf(DEFAULT_BRUSH);
  let open = false;
  let locked = false; // while seeding or exporting labels (spec 004): no painting and no class edits, so no list or tile changes under them
  let store: LabelStore = emptyStore(0, 0);
  let queue: PaintQueue | null = null;
  let overlays: LabelOverlays | null = null;
  const dirty = new Set<string>();
  let frame = 0;
  // Paint undo (spec 010): one entry per stroke; opening a raster clears it
  const history = new UndoHistory(() => store);
  let current: StrokeEdit | null = null;

  const brush = createBrush(map, {
    side: () => BRUSH_SIZES[size]!,
    colour: () => classes[selected]!.colour,
    cells: (ws, erase) => { if (!locked) for (const w of ws) queue?.push({ w, value: selected + 1, erase, stroke: current ?? undefined }); },
    onStroke: (active) => {
      if (active) current = history.begin();
      else if (current) { history.end(current); current = null; }
      syncUndo();
    },
    panning,
  });

  const canUndo = () => history.size > 0 && !brush.stroking() && (queue?.size ?? 0) === 0;
  const syncUndo = () => { undoButton.disabled = !canUndo(); };

  // A redraw walks a whole tile, so tiles changed by many cells are redrawn once per frame.
  const flush = () => {
    frame = 0;
    const colours = classes.map((c) => c.colour);
    for (const key of dirty) overlays?.update(key, store.tiles.get(key), colours);
    dirty.clear();
  };
  const redraw = (keys: Iterable<string>) => {
    for (const k of keys) dirty.add(k);
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const clearHistory = () => {
    history.clear();
    current = null;
    syncUndo();
  };
  const undo = () => {
    if (!canUndo()) return;
    const keys = history.undo();
    if (keys) {
      keepMasks(store, queue!.masks, null);
      redraw(keys);
    }
    syncUndo();
  };

  const setMode = (m: BrushMode) => {
    brush.setMode(m);
    $("mode-paint").setAttribute("aria-pressed", String(m === "paint"));
    $("mode-pan").setAttribute("aria-pressed", String(m === "pan"));
    if (m === "paint") onPaint();
  };
  const step = (d: number) => {
    size = Math.max(0, Math.min(BRUSH_SIZES.length - 1, size + d));
    sizeText.textContent = `Brush: ${BRUSH_SIZES[size]} px`;
    brush.refresh();
  };
  const select = (i: number) => {
    selected = i;
    markSelected(list, i);
    brush.refresh();
  };
  const render = () => {
    renderClasses(list, classes, selected, locked, {
      select,
      rename: (i, name) => {
        if (locked) return classes[i]!.name;
        const ok = checkName(classes, i, name);
        if (ok === null) { say(MESSAGES.className); return classes[i]!.name; }
        classes[i]!.name = ok;
        return ok;
      },
      recolour: (i, colour) => {
        if (locked) return;
        classes[i]!.colour = colour;
        redraw(store.tiles.keys());
        brush.refresh();
      },
    });
    add.disabled = locked || classes.length >= MAX_CLASSES;
  };
  render();

  undoButton.addEventListener("click", undo);
  $("mode-paint").addEventListener("click", () => setMode("paint"));
  $("mode-pan").addEventListener("click", () => setMode("pan"));
  $("brush-smaller").addEventListener("click", () => step(-1));
  $("brush-larger").addEventListener("click", () => step(1));
  add.addEventListener("click", () => {
    if (locked || classes.length >= MAX_CLASSES) return;
    classes.push(nextClass(classes));
    render();
  });
  // Chromium marks the focused element :focus-visible on any keydown, so how it got focus is read when focus arrives
  let keyFocused = false;
  window.addEventListener("focusin", (e) => { keyFocused = e.target instanceof Element && e.target.matches(":focus-visible"); });
  window.addEventListener("pointerdown", () => { keyFocused = false; }, true);
  // Keyboard users press a control they tabbed to with Space; a mouse click leaves focus there, and then Space means Pan
  const nativeSpace = (el: Element | null) => inTextField(el) || el instanceof HTMLSelectElement
    || (keyFocused && (el instanceof HTMLButtonElement || el instanceof HTMLInputElement));
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.addEventListener("keydown", (e) => {
    // Ctrl+Z (Cmd+Z on macOS); a text field keeps its own undo
    if (e.key.toLowerCase() === "z" && (mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (open && !inTextField(document.activeElement)) { e.preventDefault(); undo(); }
      return;
    }
    if (!open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") {
      if (!nativeSpace(document.activeElement)) { e.preventDefault(); brush.setSpace(true); }
      return;
    }
    if (inTextField(document.activeElement)) return;
    if (e.key === "[") step(-1);
    else if (e.key === "]") step(1);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= classes.length) select(Number(e.key) - 1);
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    if (open && !nativeSpace(document.activeElement)) e.preventDefault();
    brush.setSpace(false);
  });

  /** While seeding or exporting labels: the brush and the class list's edits are off; selecting still works. */
  function lock(on: boolean): void {
    if (locked === on) return;
    locked = on;
    brush.setLocked(on);
    render();
  }

  return {
    /** Start labelling newly opened local imagery: an empty store, no masks, Paint mode. */
    open(source: RasterSource): void {
      queue?.clear();
      clearHistory(); // after the queue, which hands its dropped strokes to the history
      overlays?.clear();
      dirty.clear();
      const { width, height, epsg, gt } = source.meta;
      const grid = { width, height, epsg, gt };
      store = emptyStore(width, height);
      lock(false);
      queue = new PaintQueue(source, () => store, {
        applied: (w: Window) => { redraw(tileKeys(w)); onChange(); syncUndo(); },
        full: () => say(MESSAGES.labelLimit),
        busy: () => { onBusy(); syncUndo(); },
        error: (e) => say((e as Error).message),
      }, history);
      overlays = new LabelOverlays(map, grid);
      open = true;
      panel.hidden = false;
      brush.setImagery(grid);
      setMode("paint");
      onChange();
      syncUndo();
    },
    /** Swap in seeded labels and their class list (spec 004); masks of tiles no longer stored are freed. */
    replace(next: LabelStore, list: LabelClass[]): void {
      const keys = new Set([...store.tiles.keys(), ...next.tiles.keys()]);
      store = next;
      classes.splice(0, classes.length, ...list);
      if (selected >= classes.length) selected = 0;
      // the queue is empty (seeding waits for it), so no footprint is pending (spec 003 Storage)
      if (queue) keepMasks(store, queue.masks, null);
      redraw(keys); // colours may have changed too
      render();
      brush.refresh();
      onChange();
    },
    lock,
    /** The labels and class list now, for seeding to build on. */
    current: () => ({ store, classes }),
    setMode,
    syncHandlers: brush.syncHandlers,
    /** Empty the undo history (the store was replaced) and update the Undo button. */
    clearHistory,
    /** A paint or erase stroke is in progress. */
    stroking: brush.stroking,
    /** True when any pixel is labelled (no all-zero tile is kept). */
    hasLabels: () => store.tiles.size > 0,
    /** Stroke cells are waiting for nodata masks. */
    busy: () => (queue?.size ?? 0) > 0,
    store: () => store,
    classes: () => classes,
    /** Classes with labelled pixels; a stored value with no class doesn't count. */
    paintedClasses: () => paintedClasses(store, classes.length),
  };
}
