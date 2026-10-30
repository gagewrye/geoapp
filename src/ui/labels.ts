import type { Map as MapLibreMap } from "maplibre-gl";
import { MAX_CLASSES, checkName, initialClasses, nextClass, type LabelClass } from "../core/classes";
import { emptyStore, tileWindow, type LabelStore } from "../core/labelStore";
import { pixelAt } from "../core/pixel";
import { baseTile, type MaskBase } from "../io/maskBase";
import type { PaintOp } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import { createBrush, type BrushMode } from "../map/brush";
import { initBrushSize } from "./brushSize";
import { markSelected, renderClasses } from "./classList";
import { labelDisplay } from "./labelDisplay";
import { initLabelView } from "./labelView";
import { MESSAGES } from "./messages";
import { initPaint } from "./paint";
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
  /** Spec 020's tile reads are queued or in flight, and an import runs: background mask reads wait (spec 023 F3). */
  imageryBusy: () => boolean;
  importing: () => boolean;
  /** e2e hooks (spec 023): F6 off when false, and each paint op pushed. */
  sweep?: () => boolean;
  op?: (op: PaintOp) => void;
};

/** The labels an import took off the map (spec 021), to restore if it doesn't replace them. */
export type Held = { readonly store: LabelStore; readonly base: MaskBase | null };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "color", "file", "range", "image"]);
export const inTextField = (el: Element | null) => el instanceof HTMLTextAreaElement
  || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

/** Brush labels on local imagery (spec 003): panel, classes, shortcuts, store, paint queue and overlays. */
export function initLabels({ map, say, onBusy, onChange, panning, imageryBusy, importing, sweep, op }: Deps) {
  const panel = $("brush-panel"), list = $("classes"), add = $<HTMLButtonElement>("class-add");
  const classes: LabelClass[] = initialClasses();
  let selected = 0;
  let open = false;
  let locked = false; // while seeding or exporting labels (spec 004): no painting and no class edits, so no list or tile changes under them
  let store: LabelStore = emptyStore(0, 0);
  let imagery: RasterSource | null = null;
  let base: MaskBase | null = null; // an imported mask under the stored tiles (spec 014)
  const display = labelDisplay(map, () => store, () => classes.map((c) => c.colour));
  const redraw = display.redraw;
  // Paint undo (spec 010): one entry per stroke; opening a raster or replacing the store clears it
  const undo = initUndo({
    button: $<HTMLButtonElement>("undo"),
    store: () => store,
    blocked: () => locked || brush.stroking() || paint.size() > 0,
    shortcut: () => open && !inTextField(document.activeElement),
    undone: (keys) => {
      redraw(keys);
      onChange(); // Import and Export follow the store (spec 004)
    },
  });

  const paint = initPaint({
    store: () => store, base: () => base, history: undo.history, stroke: undo.current, value: () => selected + 1, locked: () => locked,
    applied: (keys) => { redraw(keys); onChange(); undo.sync(); },
    prefetch: display.prefetch, say,
    busy: () => { onBusy(); undo.sync(); },
    imageryBusy, importing, sweep, op,
  });
  const brush = createBrush(map, {
    side: () => size.side(),
    colour: () => classes[selected]!.colour,
    cells: paint.cells,
    hovered: paint.hovered,
    onStroke: undo.stroke,
    panning,
  });

  const setMode = (m: BrushMode) => {
    brush.setMode(m);
    $("mode-paint").setAttribute("aria-pressed", String(m === "paint"));
    $("mode-pan").setAttribute("aria-pressed", String(m === "pan"));
  };
  // Paint never applies to labels you can't see (spec 016): hiding selects Pan, and Paint shows them first
  const view = initLabelView(map, (visible) => { if (!visible) setMode("pan"); });
  const size = initBrushSize(() => brush.refresh());
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

  $("mode-paint").addEventListener("click", () => { view.show(); setMode("paint"); });
  $("mode-pan").addEventListener("click", () => setMode("pan"));
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
    if (e.key === "[") size.step(-1);
    else if (e.key === "]") size.step(1);
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

  /** Paint is offered only once the imagery is drawn (spec 019); Pan stays selected until the user picks Paint. */
  function imageryReady(ready: boolean): void {
    $<HTMLButtonElement>("mode-paint").disabled = !ready;
  }

  return {
    /** Start labelling newly opened local imagery: an empty store, no masks, labels shown, Pan mode (spec 016). */
    open(source: RasterSource): void {
      paint.open(source); // clears the old queue and stops the old raster's mask reads
      undo.clear(); // after the queue, which hands its dropped strokes to the history
      base = null; // opening a raster drops the mask
      imagery = source;
      const { width, height, epsg, gt } = source.meta;
      const grid = { width, height, epsg, gt };
      store = emptyStore(width, height);
      lock(false);
      view.reset();
      display.open(grid);
      open = true;
      panel.hidden = false;
      brush.setImagery(grid);
      setMode("pan");
      imageryReady(false); // until main draws its preview (spec 019)
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
      redraw(keys); // colours may have changed too
      render();
      setMode("pan"); // an import selects Pan (spec 014 as amended by spec 016)
      brush.refresh();
      onChange();
    },
    /** Takes the labels off the map for an import (spec 021); the store, classes, base and history stay as they are. */
    hold(): Held {
      display.hide();
      return { store, base };
    },
    /** Draws held labels again, history kept; does nothing once a raster open or a replace changed them. */
    restore(held: Held): void {
      if (held.store !== store || held.base !== base) return;
      display.setMask(base?.preview ?? null);
      redraw(store.tiles.keys());
    },
    lock,
    imageryReady,
    /** Starts reading every valid mask in the background, from the view's centre band (spec 023 F3; after "Raster opened."). */
    startMasks(): void {
      if (!imagery) return;
      const c = map.getCenter(), row = pixelAt(imagery.meta, c.lng, c.lat)[1];
      paint.start(Number.isFinite(row) ? row : 0);
    },
    /** Every valid mask has been read once (e2e). */
    masksDone: paint.finished,
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
    /** Pointer moves are waiting for valid masks. */
    busy: () => paint.size() > 0,
    store: () => store,
    classes: () => classes,
  };
}
