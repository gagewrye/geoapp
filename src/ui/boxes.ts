import type { Map as MapLibreMap } from "maplibre-gl";
import {
  addBox, boxesAt, cycleBox, emptyBoxes, moveRect, rectFrom, removeBox, resizeRect, setBox, type Box, type Rect,
} from "../core/boxes";
import type { Grid } from "../core/types";
import type { UndoHistory } from "../io/undoHistory";
import type { BrushMode } from "../map/brush";
import { boxLayer } from "../map/boxLayer";
import { createBoxTool, type BoxGesture } from "../map/boxTool";
import type { KindId } from "./kinds";

type Cell = [number, number];
type Layer = Pick<ReturnType<typeof boxLayer>, "open" | "show" | "edit" | "visible">;
type Deps = {
  layer: Layer;
  /** The one undo history (ADR 0038); each box edit is one entry in it. */
  history: () => UndoHistory;
  colours: () => string[];
  /** The selected class's value (index + 1), which a new box gets. */
  value: () => number;
  /** The mode is Box: handles show and drags edit (scope 3). */
  boxMode: () => boolean;
  kind: () => KindId;
  /** Labels locked (specs 004, 031) or a peek held (spec 034): no gesture or key acts. */
  blocked: () => boolean;
  /** The boxes, the selection or a drag changed: the Undo buttons, the status bar, Import and Export follow. */
  changed: () => void;
};
type Edit = { g: BoxGesture; orig: Box | null; rect: Rect };

/** The Box tool's state (spec 064): the box store, the selection, the drag in progress, their undo entries, keys and status. */
export function initBoxes(d: Deps) {
  let store = emptyBoxes(), grid: Grid | null = null, selected: number | null = null, last: Cell | null = null, edit: Edit | null = null;
  const sel = () => (selected === null ? null : store.boxes.get(selected) ?? null);
  const show = () => d.layer.show(store.boxes.values(), d.colours(), selected, d.boxMode());
  const colour = (v: number) => d.colours()[v - 1] ?? "#888";
  /** One undo entry for the boxes with these ids, which apply changes (none if nothing changed); then the boxes source is set once. */
  const commit = (ids: number[], apply: () => void) => {
    const h = d.history(), s = h.begin();
    h.recordBoxes(s, ids);
    apply();
    h.end(s);
    show();
    d.changed();
  };
  const rectAt = ({ g, orig }: Edit, c: Cell): Rect => {
    if (g.kind === "resize") return resizeRect(orig!, g.handle, c, grid!);
    return g.kind === "move" ? moveRect(orig!, c[0] - g.from[0], c[1] - g.from[1], grid!) : rectFrom(g.from, c, grid!)!;
  };
  const cancel = (): boolean => {
    if (!edit) return false;
    edit = null;
    d.layer.edit(null, "");
    d.changed();
    return true;
  };

  /** map/boxTool's gestures. */
  const gestures = {
    /** The selected box, which drags move and resize; none outside Box mode. */
    selected: (): Rect | null => (d.boxMode() ? sel() : null),
    start(g: BoxGesture): void {
      const orig = g.kind === "draw" ? null : sel();
      if (edit || !grid || d.blocked() || !d.boxMode() || (g.kind !== "draw" && !orig)) return;
      edit = { g, orig, rect: orig ?? rectFrom(g.from, g.from, grid)! };
      d.changed(); // Undo waits for the release
    },
    /** Only the edit layer follows a drag; the stored box it replaces is filtered out until the release. A lock or peek since the press cancels it. */
    drag(c: Cell): void {
      if (!edit || (d.blocked() && cancel())) return;
      edit.rect = rectAt(edit, c);
      d.layer.edit(edit.rect, colour(edit.orig?.value ?? d.value()), edit.orig?.id ?? null);
    },
    end(c: Cell): void {
      const e = edit;
      if (!e || (d.blocked() && cancel())) return;
      e.rect = rectAt(e, c);
      edit = null;
      d.layer.edit(null, "");
      if (e.orig) commit([e.orig.id], () => setBox(store, { ...e.orig!, ...e.rect }));
      else commit([store.next], () => { selected = addBox(store, e.rect, d.value()).id; });
    },
    cancel,
    /** Selects the smallest box under the pixel, the next on another click there, or none (scope 2). */
    click(c: Cell): void {
      if (edit || d.blocked()) return;
      const again = last !== null && last[0] === c[0] && last[1] === c[1];
      last = c;
      selected = cycleBox(boxesAt(store, c[0], c[1]), selected, again);
      show();
      d.changed();
    },
  };

  return {
    gestures,
    /** For labelKeys (scope 4): Escape cancels a drag, else clears the selection; Delete and Backspace delete the selected box. Each is true when it acted. */
    keys: {
      escape(): boolean {
        if (d.blocked()) return false;
        if (cancel()) return true;
        if (selected === null) return false;
        selected = null;
        show();
        d.changed();
        return true;
      },
      remove(): boolean {
        const b = sel();
        if (!b || edit || d.blocked()) return false;
        commit([b.id], () => { removeBox(store, b.id); selected = null; });
        return true;
      },
    },
    /** A class chosen by key or row click also gives the selected box that class, as one entry (decision 2). */
    classChosen(i: number): void {
      const b = sel();
      if (b && !edit && !d.blocked() && b.value !== i + 1) commit([b.id], () => setBox(store, { ...b, value: i + 1 }));
    },
    /** The mode or kind changed: Masks drop the selection, and leaving Box mode cancels a drag and hides the handles. */
    modeChanged(): void {
      if (d.kind() !== "box") selected = null;
      if (!d.boxMode()) cancel();
      show();
    },
    /** An undo or redo changed these boxes; a selected box it removed is no longer selected. */
    undone(ids: number[]): void {
      if (!ids.length) return;
      if (selected !== null && !store.boxes.has(selected)) selected = null;
      show();
      d.changed();
    },
    /** A raster opened: no boxes, no selection and no drag. */
    open(g: Grid): void {
      store = emptyBoxes(); grid = g; selected = null; last = null; edit = null;
      d.layer.open(g);
    },
    /** Classes were recoloured or replaced. */
    redraw: show,
    visible: (on: boolean) => d.layer.visible(on),
    /** The selected box's width and height in pixels, for the status bar. */
    size: (): [number, number] | null => { const b = sel(); return b ? [b.x1 - b.x0, b.y1 - b.y0] : null; },
    /** Each box's value, which an import's class list must cover (decision 3). */
    values: () => [...store.boxes.values()].map((b) => b.value),
    dragging: () => edit !== null,
    store: () => store,
    grid: () => grid,
  };
}

type Wiring = Pick<Deps, "blocked" | "changed"> & {
  undo: { history: UndoHistory };
  panel: { classes(): { colour: string }[]; selected(): number };
  modes: { mode(): BrushMode; kind(): KindId };
  /** brush.boxing: Box mode with a raster open and Space not held. */
  brush: { boxing(): boolean };
  /** A middle-button pan is in progress (spec 009). */
  panning: () => boolean;
};

/** initBoxes on the map: the box layer, and the pointer input that feeds its gestures. */
export function wireBoxes(map: MapLibreMap, { undo, panel, modes, brush, panning, ...w }: Wiring) {
  const layer = boxLayer(map);
  const boxes = initBoxes({
    ...w, layer, history: () => undo.history, colours: () => panel.classes().map((c) => c.colour), value: () => panel.selected() + 1,
    boxMode: () => modes.mode() === "box", kind: () => modes.kind(),
  });
  createBoxTool(map, { ...boxes.gestures, active: () => brush.boxing() && !panning(), grid: boxes.grid, handleAt: layer.handleAt });
  return boxes;
}
