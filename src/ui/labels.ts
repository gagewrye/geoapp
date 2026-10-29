import type { Map as MapLibreMap } from "maplibre-gl";
import { MAX_CLASSES, checkName, initialClasses, nextClass, type LabelClass } from "../core/classes";
import type { Window } from "../core/grid";
import { emptyStore, keepMasks, tileKeys, tileWindow, type LabelStore } from "../core/labelStore";
import { BRUSH_SIZES, DEFAULT_BRUSH } from "../core/pixel";
import { baseTile, type MaskBase } from "../io/maskBase";
import { PaintQueue } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import { createBrush, type BrushMode } from "../map/brush";
import { markSelected, renderClasses } from "./classList";
import { labelDisplay } from "./labelDisplay";
import { MESSAGES, readErrorMessage } from "./messages";
import { initUndo } from "./undo";

type Deps = {
  map: MapLibreMap;
  say: (text: string) => void;
  /** The paint queue became busy or idle (Import labels and Export labels wait while it is busy). */
  onBusy: () => void;
  /** The store changed: a cell applied, labels were replaced, or new imagery opened. */
  onChange: () => void;
  /** A middle-button pan is in progress (spec 009). */
  panning: () => boolean;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "color", "file", "range", "image"]);
export const inTextField = (el: Element | null) => el instanceof HTMLTextAreaElement
  || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

/** Brush labels on local imagery (spec 003): panel, classes, shortcuts, store, paint queue and overlays. */
export function initLabels({ map, say, onBusy, onChange, panning }: Deps) {
  const panel = $("brush-panel"), list = $("classes"), add = $<HTMLButtonElement>("class-add"), sizeText = $("brush-size");
  const classes: LabelClass[] = initialClasses();
  let selected = 0;
  let size = BRUSH_SIZES.indexOf(DEFAULT_BRUSH);
  let open = false;
  let locked = false; // while seeding or exporting labels (spec 004): no painting and no class edits, so no list or tile changes under them
  let store: LabelStore = emptyStore(0, 0);
  let queue: PaintQueue | null = null;
  let imagery: RasterSource | null = null;
  let base: MaskBase | null = null; // an imported mask under the stored tiles (spec 014)
  const display = labelDisplay(map, () => store, () => classes.map((c) => c.colour));
  const redraw = display.redraw;
  // Paint undo (spec 010): one entry per stroke; opening a raster or replacing the store clears it
  const undo = initUndo({
    button: $<HTMLButtonElement>("undo"),
    store: () => store,
    blocked: () => locked || brush.stroking() || (queue?.size ?? 0) > 0,
    shortcut: () => open && !inTextField(document.activeElement),
    undone: (keys) => {
      keepMasks(store, queue!.masks, null);
      redraw(keys);
      onChange(); // Seed mode, Import, Seed and Export follow the store (spec 004)
    },
  });

  const brush = createBrush(map, {
    side: () => BRUSH_SIZES[size]!,
    colour: () => classes[selected]!.colour,
    cells: (ws, erase) => { if (!locked) for (const w of ws) queue?.push({ w, value: selected + 1, erase, stroke: undo.current() ?? undefined }); },
    onStroke: undo.stroke,
    panning,
  });

  const setMode = (m: BrushMode) => {
    brush.setMode(m);
    $("mode-paint").setAttribute("aria-pressed", String(m === "paint"));
    $("mode-pan").setAttribute("aria-pressed", String(m === "pan"));
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
        redraw(store.tiles.keys(), true);
        brush.refresh();
      },
    });
    add.disabled = locked || classes.length >= MAX_CLASSES;
  };
  render();

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
  window.addEventListener("keydown", (e) => {
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
    undo.sync();
  }

  return {
    /** Start labelling newly opened local imagery: an empty store, no masks, Paint mode. */
    open(source: RasterSource): void {
      queue?.clear();
      undo.clear(); // after the queue, which hands its dropped strokes to the history
      base = null; // opening a raster drops the mask
      imagery = source;
      const { width, height, epsg, gt } = source.meta;
      const grid = { width, height, epsg, gt };
      store = emptyStore(width, height);
      lock(false);
      queue = new PaintQueue(source, () => store, {
        applied: (w: Window) => { redraw(tileKeys(w)); onChange(); undo.sync(); },
        full: () => say(store.base ? MESSAGES.editLimit : MESSAGES.labelLimit),
        busy: () => { onBusy(); undo.sync(); },
        error: (e) => say(readErrorMessage(e)),
      }, undo.history, () => base);
      display.open(grid);
      open = true;
      panel.hidden = false;
      brush.setImagery(grid);
      setMode("paint");
      onChange();
      undo.sync();
    },
    /** Swap in imported labels, their class list and mask base (specs 004, 014); masks of tiles no longer stored are freed. */
    replace(next: LabelStore, list: LabelClass[], nextBase: MaskBase | null = null): void {
      const keys = new Set([...store.tiles.keys(), ...next.tiles.keys()]);
      store = next;
      base = nextBase;
      display.setMask(base?.preview ?? null);
      undo.clear(); // a seed isn't undoable, and strokes recorded against the old store can't be undone over it
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
    current: () => ({ store, classes, base }),
    /** The mask base, if one is loaded. */
    base: () => base,
    /** The effective tile at key (stored, else the mask's); null when neither exists. Reads the mask file for an unstored key. */
    async tile(key: string): Promise<Uint8Array | null> {
      const stored = store.tiles.get(key);
      if (stored) return stored.slice();
      if (!base || !imagery) return null;
      const [x0, y0] = key.split(",").map(Number) as [number, number];
      return (await baseTile(imagery, base, tileWindow(store, x0, y0))).labels;
    },
    /** A paint or erase stroke is in progress. */
    stroking: brush.stroking,
    /** True when a tile is stored or a mask with labelled pixels is loaded. */
    hasLabels: () => store.tiles.size > 0 || (base?.count ?? 0) > 0,
    /** Stroke cells are waiting for nodata masks. */
    busy: () => (queue?.size ?? 0) > 0,
    store: () => store,
    classes: () => classes,
  };
}
