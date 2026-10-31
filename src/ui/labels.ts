import type { Map as MapLibreMap } from "maplibre-gl";
import { MAX_CLASSES, checkName, initialClasses, nextClass, type LabelClass } from "../core/classes";
import { emptyStore, tileWindow, type LabelStore } from "../core/labelStore";
import { pixelAt } from "../core/pixel";
import { baseTile, type MaskBase } from "../io/maskBase";
import type { PaintOp } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import { createBrush, type BrushMode } from "../map/brush";
import { initBrushSize } from "./brushSize";
import { deferMode } from "./deferMode";
import { markSelected, renderClasses } from "./classList";
import { labelDisplay } from "./labelDisplay";
import { initLabelKeys, inTextField } from "./labelKeys";
import { initLabelView } from "./labelView";
import { MESSAGES } from "./messages";
import { initPaint } from "./paint";
import { initUndo } from "./undo";
import type { MessageKind } from "./messages";

type Deps = {
  map: MapLibreMap;
  say: (text: string, kind?: MessageKind) => void;
  /** The brush mode, selected class or brush side changed (spec 032's status bar). */
  toolChanged?: () => void;
  /** The paint queue became busy or idle (Import labels and Export labels wait while it is busy). */
  onBusy: () => void;
  /** The store changed: a cell applied, labels were replaced, or new imagery opened. */
  onChange: () => void;
  /** A middle-button pan is in progress (spec 009). */
  panning: () => boolean;
  /** Spec 020's tile reads are queued or in flight, and an import runs: background mask reads wait (spec 023 F3). */
  imageryBusy: () => boolean;
  importing: () => boolean;
  /** The map moves or just moved (spec 027): background mask reads wait for it too. */
  mapMoving?: () => boolean;
  /** What spec 031 saves: changed tile keys, record edits (classes, selection, view), replaces and stroke ends. */
  edits?: Edits;
  /** e2e hooks (spec 023): F6 off when false, and each paint op pushed. */
  sweep?: () => boolean;
  op?: (op: PaintOp) => void;
};

type Edits = { tiles(keys: Iterable<string>): void; record(): void; replaced(): void; strokeEnded(): void };
const NO_EDITS: Edits = { tiles() {}, record() {}, replaced() {}, strokeEnded() {} };

/** The labels an import took off the map (spec 021), to restore if it doesn't replace them. */
export type Held = { readonly store: LabelStore; readonly base: MaskBase | null };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Brush labels on local imagery (spec 003): panel, classes, shortcuts, store, paint queue and overlays. */
export function initLabels({ map, say, toolChanged = () => {}, onBusy, onChange, panning, imageryBusy, importing, mapMoving, sweep, op, edits = NO_EDITS }: Deps) {
  const panel = $("brush-panel"), list = $("classes"), add = $<HTMLButtonElement>("class-add");
  const classes: LabelClass[] = initialClasses();
  let selected = 0;
  let open = false;
  // spec 004's lock: no painting and no class edits, so no list or tile changes under a run (seeding or exporting
  // labels) or a restore offer (spec 031); each holds it under its own name, and it lifts once neither does
  const holders = new Set<"run" | "restore">();
  let locked = false;
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
      keys = [...keys];
      edits.tiles(keys);
      redraw(keys);
      onChange(); // Import and Export follow the store (spec 004)
    },
  });

  const paint = initPaint({
    store: () => store, base: () => base, history: undo.history, stroke: undo.current, value: () => selected + 1, locked: () => locked,
    applied: (keys) => { keys = [...keys]; edits.tiles(keys); redraw(keys); onChange(); undo.sync(); },
    prefetch: display.prefetch, stroking: () => brush.stroking(), say,
    busy: () => { onBusy(); undo.sync(); },
    imageryBusy, importing, mapMoving, sweep, op,
  });
  const brush = createBrush(map, {
    side: () => size.side(),
    colour: () => classes[selected]!.colour,
    cells: paint.cells,
    hovered: paint.hovered,
    onStroke: (active) => { undo.stroke(active); if (!active) { edits.strokeEnded(); keyed.strokeEnded(); } },
    panning,
  });

  let mode: BrushMode = "pan";
  const MODES: BrushMode[] = ["paint", "erase", "pan"];
  const setMode = (m: BrushMode) => {
    keyed.clear();
    mode = m;
    brush.setMode(m);
    toolChanged();
    for (const b of MODES) $(`mode-${b}`).setAttribute("aria-pressed", String(m === b));
  };
  // Paint and Erase never apply to labels you can't see (specs 016, 033): hiding selects Pan, and either shows them first
  const choose = (m: BrushMode) => { if (m !== "pan") view.show(); setMode(m); };
  const keyed = deferMode(() => brush.stroking(), choose);
  const view = initLabelView(map, (visible) => { if (!visible) setMode("pan"); }, () => edits.record());
  const size = initBrushSize(() => { brush.refresh(); toolChanged(); });
  const select = (i: number) => {
    selected = i;
    edits.record();
    markSelected(list, i);
    brush.refresh();
    toolChanged();
  };
  const render = () => {
    renderClasses(list, classes, selected, locked, {
      select,
      rename: (i, name) => {
        if (locked) return classes[i]!.name;
        const ok = checkName(classes, i, name);
        if (ok === null) { say(MESSAGES.className, "error"); return classes[i]!.name; }
        classes[i]!.name = ok;
        edits.record();
        toolChanged();
        return ok;
      },
      recolour: (i, colour) => {
        if (locked) return;
        classes[i]!.colour = colour;
        edits.record();
        redraw(store.tiles.keys(), true);
        brush.refresh();
      },
    });
    add.disabled = locked || classes.length >= MAX_CLASSES;
  };
  render();

  for (const m of MODES) $(`mode-${m}`).addEventListener("click", () => choose(m));
  add.addEventListener("click", () => {
    if (locked || classes.length >= MAX_CLASSES) return;
    classes.push(nextClass(classes));
    edits.record();
    render();
  });
  initLabelKeys({
    open: () => open, brush, size, select, classCount: () => classes.length,
    setMode: keyed.request, canPaint: () => !$<HTMLButtonElement>("mode-paint").disabled,
  });

  /** While seeding or exporting labels ("run") or a restore offer settles: the brush, the class list's edits and Undo are off; selecting still works. */
  function lock(on: boolean, by: "run" | "restore" = "run"): void {
    if (on) holders.add(by); else holders.delete(by);
    apply();
  }
  function apply(): void {
    if (locked === holders.size > 0) return;
    locked = !locked;
    brush.setLocked(locked);
    render();
    undo.sync();
    onBusy(); // Import labels and Export labels follow the lock
  }

  /** Paint is offered only once the imagery is drawn (spec 019); Pan stays selected until the user picks Paint. */
  function imageryReady(ready: boolean): void {
    $<HTMLButtonElement>("mode-paint").disabled = $<HTMLButtonElement>("mode-erase").disabled = !ready;
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
      holders.clear(); // the old raster's run or offer no longer holds these labels
      apply();
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
      edits.replaced();
      onChange();
    },
    /** Swaps in a restored session (spec 031): replace, then its selected class and view. */
    restoreSession(next: LabelStore, list: LabelClass[], nextBase: MaskBase | null, i: number, v: { opacity: number; visible: boolean }): void {
      this.replace(next, list, nextBase);
      select(i < classes.length ? i : 0);
      view.set(v.opacity, v.visible);
    },
    selected: () => selected,
    /** The status bar's tool: mode, selected class name and brush side. */
    tool: () => ({ mode, className: classes[selected]?.name ?? "", side: size.side() }),
    view: () => view.get(),
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
    /** Spec 031 scope 4: held from "Raster opened." until the restore offer settles. */
    restoreLock: (on: boolean) => lock(on, "restore"),
    /** A restore offer holds the lock (a run's own controls follow the run). */
    restoring: () => holders.has("restore"),
    imageryReady,
    /** Starts reading every valid mask in the background, from the view's centre band (spec 023 F3; after "Raster opened."). */
    startMasks(): void {
      if (!imagery) return;
      const c = map.getCenter(), row = pixelAt(imagery.meta, c.lng, c.lat)[1];
      paint.start(Number.isFinite(row) ? row : 0);
    },
    /** Every valid mask has been read once (e2e). */
    masksDone: paint.finished,
    /** The open raster's valid masks: an import reads through them (spec 024). */
    masks: paint.masks,
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
