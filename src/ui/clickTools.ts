import type { Map as MapLibreMap } from "maplibre-gl";
import type { LabelStore } from "../core/labelStore";
import type { Grid } from "../core/types";
import { fillReader } from "../io/fill";
import type { MaskBase } from "../io/maskBase";
import type { MaskCache } from "../io/maskCache";
import type { PaintOp } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import type { UndoHistory } from "../io/undoHistory";
import type { BrushMode } from "../map/brush";
import { polygonLayer } from "../map/polygonLayer";
import { initFill } from "./fill";
import { readErrorMessage, type MessageKind } from "./messages";
import { initPolygon } from "./polygon";
import { initSmartTool, type SmartInputs } from "./smartTool";

export type { SmartInputs };

type Deps = {
  map: MapLibreMap;
  store: () => LabelStore;
  imagery: () => RasterSource | null;
  base: () => MaskBase | null;
  /** The open raster's valid masks, which a fill stops at. */
  masks: () => MaskCache | null;
  /** Undo's history, and its buttons' sync once a fill is queued as an ended stroke. */
  undo: { history: UndoHistory; sync(): void };
  /** Queue a fill (the paint queue: nodata and base tiles as for Paint). */
  push: (op: PaintOp) => void;
  panel: { classes(): { colour: string }[]; selected(): number };
  locked: () => boolean;
  say: (text: string, kind?: MessageKind) => void;
  modes: { mode(): BrushMode; request(m: BrushMode): void; smartOff(why: string): void; canSmart(): boolean };
  /** A fill started or ended: Import labels and Export labels wait for it, as they do for the paint queue. */
  onBusy: () => void;
  /** The paint queue holds moves. */
  pending: () => boolean;
  /** The status bar's tool changed (reading started or ended). */
  toolChanged: () => void;
  /** Spec 031's save, which follows each stroke's end. */
  edits: { strokeEnded(): void };
  /** Smart select's model loader and imagery read; without them there is no Smart tool (unit tests). */
  smart?: SmartInputs;
};

/** The tools that take clicks (specs 046, 054): Smart select, Fill and Polygon. The map's clicks go to the selected one, and leaving a tool drops what it had pending. */
export function initClickTools(d: Deps) {
  const colour = () => d.panel.classes()[d.panel.selected()]!.colour, value = () => d.panel.selected() + 1;
  const ended = () => { d.undo.sync(); d.edits.strokeEnded(); };
  const smart = d.smart && initSmartTool({ ...d, ...d.smart });
  const layer = polygonLayer(d.map);
  const fill = initFill({
    dims: d.store, push: d.push, history: d.undo.history, value, locked: d.locked, pending: d.pending, filled: ended, say: d.say,
    reader: () => { const imagery = d.imagery(), masks = d.masks(); return imagery && masks ? fillReader(imagery, d.store(), d.base(), masks) : null; },
    changed: () => { d.undo.sync(); d.onBusy(); d.toolChanged(); }, error: (e) => d.say(readErrorMessage(e), "error"),
  });
  const polygon = initPolygon({
    dims: d.store, near: layer.near, show: (c) => layer.show(c, colour()), push: d.push, history: d.undo.history, value, locked: d.locked, applied: ended, say: d.say,
  });

  return {
    /** A click on a raster cell; Shift (include false) means something only to Smart. */
    click(cell: [number, number], include: boolean): void {
      const m = d.modes.mode();
      if (m === "smart") smart?.click(cell, include);
      else if (m === "fill") void fill.click(cell);
      else if (m === "polygon") polygon.click(cell);
    },
    /** A right click on the map: Polygon steps back one corner, and Smart discards its selection (spec 049). */
    rightClick(): void { if (d.modes.mode() === "polygon") polygon.back(); else smart?.discard(); },
    /** The mode changed: a tool no longer selected drops its prompt, its read or its outline. */
    modeChanged(): void {
      const m = d.modes.mode();
      if (m !== "smart") smart?.discard();
      if (m !== "fill") fill.cancel();
      if (m !== "polygon") polygon.discard();
    },
    chooseSmart(): void { void smart?.choose(); },
    /** For labelKeys: Smart's M, Enter and Escape, and Polygon's Enter, Backspace and Escape. */
    keys: { smart: smart?.keys, polygon: { apply: polygon.apply, back: polygon.back, discard: polygon.discard } },
    /** A raster opened: nothing pending. */
    open(grid: Grid): void { smart?.open(grid); fill.cancel(); polygon.open(); layer.open(grid); },
    /** The selected class or its colour changed. */
    redraw(): void { smart?.redraw(); polygon.redraw(); },
    /** The selected tool is reading (Smart encodes, or a fill is read or applied), which the status bar says. */
    reading: () => (d.modes.mode() === "smart" ? smart?.reading() ?? false : d.modes.mode() === "fill" && fill.busy()),
    /** A fill is being read or applied: Undo, Import labels and Export labels wait for it. */
    filling: fill.busy,
  };
}
