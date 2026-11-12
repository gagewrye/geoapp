import type { Map as MapLibreMap } from "maplibre-gl";
import type { Window } from "../core/grid";
import type { LabelStore } from "../core/labelStore";
import type { Grid } from "../core/types";
import type { PaintOp } from "../io/paintQueue";
import type { UndoHistory } from "../io/undoHistory";
import type { BrushMode } from "../map/brush";
import { SmartLayer } from "../map/smartLayer";
import { errorText, MESSAGES, type MessageKind } from "./messages";
import { initSmart } from "./smart";
import type { SmartLoad } from "./smartLoad";

/** What main gives the labels for Smart select: the model loader, and the encoder tensor of a window of the open imagery, as displayed. */
export type SmartInputs = { load: SmartLoad; input: (w: Window, signal: AbortSignal) => Promise<Float32Array> };

type Deps = SmartInputs & {
  map: MapLibreMap;
  store: () => LabelStore;
  /** Undo's history, and its buttons' sync once a fill is queued as an ended stroke. */
  undo: { history: UndoHistory; sync(): void };
  /** Queue a fill (the paint queue: nodata and base tiles as for Paint). */
  push: (op: PaintOp) => void;
  panel: { classes(): { colour: string }[]; selected(): number };
  locked: () => boolean;
  say: (text: string, kind?: MessageKind) => void;
  modes: { request(m: BrushMode): void; smartOff(why: string): void; canSmart(): boolean };
  /** The status bar's tool changed (reading started or ended). */
  toolChanged: () => void;
  /** Spec 031's save, which follows each stroke's end. */
  edits: { strokeEnded(): void };
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Smart select on the map and page (spec 046): its first use, the preview layer, the apply button and the status. */
export function initSmartTool(d: Deps) {
  let layer: SmartLayer | null = null, reading = false;
  const applyButton = $<HTMLButtonElement>("smart-apply");
  const smart = initSmart({
    dims: d.store, segmenter: d.load.current, input: d.input, history: d.undo.history, push: d.push, value: () => d.panel.selected() + 1, locked: d.locked,
    show: (m) => { layer?.show(m, d.panel.classes()[d.panel.selected()]!.colour); applyButton.disabled = !m; },
    reading: (on) => { reading = on; d.toolChanged(); },
    error: (e) => d.say(errorText(e), "error"),
  });
  const apply = () => {
    if (!smart.apply()) return false;
    d.undo.sync();
    d.edits.strokeEnded();
    return true;
  };
  applyButton.addEventListener("click", apply);
  /** M or the Smart button: Smart is selected once the model is loaded, if WebGPU allows it. */
  const choose = async (): Promise<void> => {
    const r = await d.load.ensure();
    if (r === "no-webgpu") d.modes.smartOff(MESSAGES.smartUnavailable); // ensure() showed the popup
    else if (r === "ok" && d.modes.canSmart()) d.modes.request("smart");
  };

  return {
    choose,
    click: smart.click,
    discard: smart.discard,
    /** For labelKeys: M, Enter and Escape. */
    keys: { choose: () => void choose(), canChoose: d.modes.canSmart, apply, discard: smart.discard },
    /** A raster opened: its grid, no prompt and no embedding. */
    open(grid: Grid): void {
      smart.open();
      layer?.clear();
      layer = new SmartLayer(d.map, grid);
    },
    redraw: smart.redraw,
    reading: () => reading,
  };
}
