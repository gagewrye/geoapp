import type { Map as MapLibreMap } from "maplibre-gl";
import type { LabelClass } from "../core/classes";
import { emptyStore, tileWindow, type LabelStore } from "../core/labelStore";
import { pixelAt } from "../core/pixel";
import { baseTile, type MaskBase } from "../io/maskBase";
import type { PaintOp } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import { createBrush } from "../map/brush";
import { initBrushSize } from "./brushSize";
import { initClassPanel } from "./classPanel";
import { labelDisplay } from "./labelDisplay";
import { initLabelKeys, inTextField } from "./labelKeys";
import { initLabelView } from "./labelView";
import { initModes } from "./modes";
import { initPaint } from "./paint";
import { initPicker } from "./picker";
import { initSmartTool, type SmartInputs } from "./smartTool";
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
  /** e2e hooks (spec 023): F6 off when false, and each paint op pushed. Smart select's model loader and imagery read (spec 046). */
  sweep?: () => boolean;
  op?: (op: PaintOp) => void; smart?: SmartInputs;
};

type Edits = { tiles(keys: Iterable<string>): void; record(): void; replaced(): void; strokeEnded(): void };
const NO_EDITS: Edits = { tiles() {}, record() {}, replaced() {}, strokeEnded() {} };

/** The labels an import took off the map (spec 021), to restore if it doesn't replace them. */
export type Held = { readonly store: LabelStore; readonly base: MaskBase | null };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Brush labels on local imagery (spec 003): panel, classes, shortcuts, store, paint queue and overlays. */
export function initLabels({ map, say, toolChanged = () => {}, onBusy, onChange, panning, imageryBusy, importing, mapMoving, sweep, op, smart: smartDeps, edits = NO_EDITS }: Deps) {
  let open = false;
  // spec 004's lock: no painting and no class edits, so no list or tile changes under a run (seeding or exporting
  // labels) or a restore offer (spec 031); each holds it under its own name, and it lifts once neither does
  const holders = new Set<"run" | "restore">();
  let locked = false;
  let store: LabelStore = emptyStore(0, 0);
  let imagery: RasterSource | null = null;
  let base: MaskBase | null = null; // an imported mask under the stored tiles (spec 014)
  // the Classes section (spec 036)
  const panel = initClassPanel({
    list: $("classes"), add: $<HTMLButtonElement>("class-add"), say, locked: () => locked,
    recoloured: () => { edits.record(); redraw(store.tiles.keys(), true); brush.refresh(); smart?.redraw(); },
    selectedChanged: () => { edits.record(); brush.refresh(); smart?.redraw(); toolChanged(); },
    edited: () => { edits.record(); toolChanged(); },
  });
  const picker = initPicker({ tile, dims: () => store, classes: panel.classes, select: panel.select, say }); // Alt+click or I (spec 038)
  /** The effective tile at key (stored, else the mask's); null when neither exists. Reads the mask file for an unstored key. */
  async function tile(key: string): Promise<Uint8Array | null> {
    const stored = store.tiles.get(key), [x0, y0] = key.split(",").map(Number) as [number, number];
    return stored || !base || !imagery ? stored?.slice() ?? null : (await baseTile(imagery, base, tileWindow(store, x0, y0))).labels;
  }
  const display = labelDisplay(map, () => store, () => panel.classes().map((c) => c.colour));
  const redraw = display.redraw;
  // Paint undo and redo (specs 010, 037): one entry per stroke; opening a raster or replacing the store clears it
  const undo = initUndo({
    button: $<HTMLButtonElement>("undo"), redoButton: $<HTMLButtonElement>("redo"), store: () => store,
    blocked: () => locked || brush.stroking() || paint.size() > 0, shortcut: () => open && !inTextField(document.activeElement),
    undone: (keys) => { keys = [...keys]; edits.tiles(keys); redraw(keys); onChange(); }, // Import and Export follow the store (spec 004)
  });

  const paint = initPaint({
    store: () => store, base: () => base, history: undo.history, stroke: undo.current, value: () => panel.selected() + 1, locked: () => locked,
    applied: (keys) => { keys = [...keys]; edits.tiles(keys); redraw(keys); onChange(); undo.sync(); },
    prefetch: display.prefetch, stroking: () => brush.stroking(), say,
    busy: () => { onBusy(); undo.sync(); }, imageryBusy, importing, mapMoving, sweep, op,
  });
  const brush = createBrush(map, {
    side: () => size.side(), colour: () => panel.classes()[panel.selected()]!.colour, cells: paint.cells, hovered: paint.hovered,
    onStroke: (active) => { undo.stroke(active); if (!active) { edits.strokeEnded(); modes.strokeEnded(); } }, panning, pick: picker.pick,
    click: (cell, include) => smart?.click(cell, include) }); // Smart mode's clicks (spec 046)

  const view = initLabelView(map, (visible) => { if (!visible) modes.setMode("pan"); }, () => edits.record()); // hiding labels selects Pan (spec 016)
  const modes = initModes({ brush, view, toolChanged: () => { if (modes.mode() !== "smart") smart?.discard(); toolChanged(); }, smart: () => void smart?.choose() }); // leaving Smart drops its prompt
  const smart = smartDeps && initSmartTool({ map, store: () => store, undo, push: paint.push, panel, locked: () => locked, say, modes, toolChanged, edits, ...smartDeps });
  const size = initBrushSize(() => { brush.refresh(); toolChanged(); });
  initLabelKeys({
    open: () => open, brush, size, select: panel.select, classCount: () => panel.classes().length, pick: () => picker.pick(brush.hoverCell()),
    setMode: modes.request, canPaint: modes.canPaint, stroking: brush.stroking, view: { toggle: view.toggle, peek: modes.peek }, smart: smart?.keys,
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
    panel.render();
    undo.sync();
    onBusy(); // Import labels and Export labels follow the lock
  }

  return {
    /** Start labelling newly opened local imagery: an empty store, no masks, labels shown, Pan mode (spec 016). */
    open(source: RasterSource): void {
      modes.clearQueued(); // a mode key queued mid-stroke mustn't apply when brush.setImagery ends that stroke (spec 034)
      paint.open(source); // clears the old queue and stops the old raster's mask reads
      undo.clear(); // after the queue, which hands its dropped strokes to the history
      base = null; picker.cancel(); // opening a raster drops the mask, and a pick still reading the old one
      imagery = source;
      const { width, height, epsg, gt } = source.meta, grid = { width, height, epsg, gt };
      store = emptyStore(width, height);
      holders.clear(); // the old raster's run or offer no longer holds these labels
      apply();
      view.reset();
      display.open(grid);
      open = true;
      brush.setImagery(grid); smart?.open(grid);
      modes.setMode("pan");
      modes.ready(false); // until main draws its preview (spec 019)
      onChange();
      undo.sync();
    },
    /** Swap in imported labels, their class list and mask base (specs 004, 014); masks of tiles no longer stored are freed. */
    replace(next: LabelStore, list: LabelClass[], nextBase: MaskBase | null = null): void {
      const keys = new Set([...store.tiles.keys(), ...next.tiles.keys()]);
      store = next;
      base = nextBase;
      display.setMask(base?.preview ?? null);
      undo.clear(); picker.cancel(); // a seed isn't undoable, strokes recorded against the old store can't be undone over it, nor a pick apply
      panel.replace(list);
      redraw(keys); // colours may have changed too
      modes.setMode("pan"); // an import selects Pan (spec 014 as amended by spec 016)
      brush.refresh();
      edits.replaced();
      onChange();
    },
    /** Swaps in a restored session (spec 031): replace, then its selected class and view. */
    restoreSession(next: LabelStore, list: LabelClass[], nextBase: MaskBase | null, i: number, v: { opacity: number; visible: boolean }): void {
      this.replace(next, list, nextBase);
      panel.select(i < list.length ? i : 0);
      view.set(v.opacity, v.visible);
    },
    selected: panel.selected,
    /** The status bar's tool: mode, selected class name and brush side. */
    tool: () => ({ mode: modes.mode(), className: panel.classes()[panel.selected()]?.name ?? "", side: size.side(), reading: smart?.reading() ?? false }),
    view: () => view.get(),
    /** Takes the labels off the map for an import (spec 021); the store, classes, base and history stay as they are. */
    hold(): Held { display.hide(); return { store, base }; },
    /** Draws held labels again, history kept; does nothing once a raster open or a replace changed them. */
    restore(held: Held): void {
      if (held.store === store && held.base === base) { display.setMask(base?.preview ?? null); redraw(store.tiles.keys()); }
    },
    lock,
    /** Spec 031 scope 4: held from "Raster opened." until the restore offer settles. */
    restoreLock: (on: boolean) => lock(on, "restore"),
    /** A restore offer holds the lock (a run's own controls follow the run). */
    restoring: () => holders.has("restore"),
    /** Paint is offered only once the imagery is drawn (spec 019); Pan stays selected until the user picks Paint. */
    imageryReady: modes.ready,
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
    tile,
    /** A paint or erase stroke is in progress. */
    stroking: brush.stroking,
    /** True when a tile is stored or a mask with labelled pixels is loaded. */
    hasLabels: () => store.tiles.size > 0 || (base?.count ?? 0) > 0,
    /** Pointer moves are waiting for valid masks. */
    busy: () => paint.size() > 0,
    store: () => store,
    classes: panel.classes,
  };
}
