import type { Window } from "../core/grid";
import { keysAround, type LabelStore } from "../core/labelStore";
import { spansBox, sweptSpans } from "../core/spans";
import { TILE_SIZE } from "../core/types";
import type { MaskBase } from "../io/maskBase";
import { HOVER, MaskCache } from "../io/maskCache";
import { PaintQueue, type PaintOp } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import type { StrokeEdit, UndoHistory } from "../io/undoHistory";
import { MESSAGES, readErrorMessage } from "./messages";
import type { MessageKind } from "./messages";

type Deps = {
  store: () => LabelStore;
  base: () => MaskBase | null;
  history: UndoHistory;
  /** The stroke in progress, whose moves record into its undo entry. */
  stroke: () => StrokeEdit | null;
  /** The selected class's label value. */
  value: () => number;
  locked: () => boolean;
  /** Redraw these tiles; a move applied to them. */
  applied: (keys: string[]) => void;
  /** Compute these tiles' quads ahead (spec 023 F5); none drops those queued. */
  prefetch: (keys: string[]) => void;
  /** A paint or erase stroke is being drawn. */
  stroking: () => boolean;
  say: (text: string, kind?: MessageKind) => void;
  /** The queue became busy or idle. */
  busy: () => void;
  /** Spec 020's loader has reads queued or in flight, and an import runs: background mask reads wait for both. */
  imageryBusy: () => boolean;
  importing: () => boolean;
  /** The map moves or just moved (spec 027): background mask reads wait. */
  mapMoving?: () => boolean;
  /** e2e: false turns spec 023 F6 off (one op per stroke cell); `op` sees each op pushed. */
  sweep?: () => boolean;
  op?: (op: PaintOp) => void;
};

/** Paint's moves and masks (specs 003, 023): one swept op per pointer move, the mask cache and its reads, the hover's lookahead. */
export function initPaint(d: Deps) {
  let queue: PaintQueue | null = null;
  let cache: MaskCache | null = null;

  return {
    /** New imagery: drops queued moves, stops the old raster's mask reads, and starts empty. */
    open(source: RasterSource): void {
      queue?.clear();
      cache?.stop();
      cache = new MaskCache(source, { loaderBusy: d.imageryBusy, paused: d.importing, moving: d.mapMoving });
      queue = new PaintQueue(source, d.store, {
        applied: d.applied,
        full: () => d.say(d.store().base ? MESSAGES.editLimit : MESSAGES.labelLimit, "error"),
        busy: d.busy,
        error: (e) => d.say(readErrorMessage(e), "error"),
      }, d.history, d.base, cache);
    },
    /** One pointer move's stroke cells: a single op over the union of their footprints (F6). */
    cells(cells: [number, number][], side: number, erase: boolean): void {
      if (d.locked() || !queue) return;
      const stroke = d.stroke() ?? undefined, value = d.value(), store = d.store();
      for (const group of d.sweep?.() === false ? cells.map((c) => [c]) : [cells]) {
        const spans = sweptSpans(group, side, store), box = spansBox(spans);
        if (!box) continue;
        const op: PaintOp = { spans, box, value, erase, stroke };
        d.op?.(op);
        queue.push(op);
      }
    },
    /** One whole op, such as spec 046's smart fill; while locked or before an open it is dropped, and its done hears so. */
    push(op: PaintOp): void {
      if (d.locked() || !queue) { op.done?.("dropped"); return; }
      d.op?.(op);
      queue.push(op);
    },
    /** The Paint hover moved: read the bands under and next to it first (F3), and compute nearby quads between strokes (F5). */
    // A quad set can take 100 ms on UTM: none is queued with no hover, or while a stroke is drawn or its moves
    // wait, so idle quad work never delays a stroke's moves and frames; tiles a stroke makes compute theirs on demand.
    hovered(w: Window | null): void {
      if (w && cache) {
        for (let b = Math.floor(w.y0 / TILE_SIZE) - 1; b <= Math.floor((w.y0 + w.height - 1) / TILE_SIZE) + 1; b++) {
          cache.need(b * TILE_SIZE, HOVER).catch(() => {}); // a failed band is read again, and reported, by a stroke's need
        }
      }
      d.prefetch(w && cache && !d.stroking() && !queue?.size ? keysAround(d.store(), w) : []);
    },
    /** Starts the background mask reads from the band holding centreRow ("Raster opened."). */
    start(centreRow: number): void { cache?.start(centreRow); },
    /** Every band's mask has been read once. */
    finished: () => cache?.finished ?? false,
    /** The open raster's mask cache, which an import fills and leaves for painting (spec 024). */
    masks: () => cache,
    /** Moves waiting for masks. */
    size: () => queue?.size ?? 0,
  };
}
