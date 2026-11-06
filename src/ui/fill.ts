import { spansBox } from "../core/spans";
import { floodFill, type FillRead } from "../io/fill";
import type { PaintOp } from "../io/paintQueue";
import type { UndoHistory } from "../io/undoHistory";
import { MESSAGES, type MessageKind } from "./messages";

type Deps = {
  dims: () => { width: number; height: number };
  /** Reads the open raster's tiles (io/fill's fillReader); null before an open. */
  reader: () => FillRead | null;
  /** Queue the fill (spec 023's PaintQueue: nodata and base tiles as for Paint). */
  push: (op: PaintOp) => void;
  history: UndoHistory;
  /** The selected class's label value. */
  value: () => number;
  locked: () => boolean;
  /** The paint queue holds moves: their tiles are about to change, so no fill reads them yet. */
  pending: () => boolean;
  /** A fill started or ended: the status bar says reading, and Undo waits. */
  changed: () => void;
  /** A fill was queued as one ended stroke. */
  filled: () => void;
  say: (text: string, kind?: MessageKind) => void;
  error: (e: unknown) => void;
};

/** The Fill tool (spec 054): a click gives its region the selected class as one undoable edit. */
export function initFill(d: Deps) {
  let run = 0, busy = false;
  const idle = () => { if (busy) { busy = false; d.changed(); } };

  return {
    /** A click on a raster cell; ignored while a fill is read or applied, while strokes are still queued, and while the labels are locked. */
    async click(cell: [number, number]): Promise<void> {
      const read = d.reader();
      if (busy || !read || d.locked() || d.pending()) return;
      const id = ++run, value = d.value();
      busy = true;
      d.changed();
      try {
        const r = await floodFill(d.dims(), cell, value, read, () => id !== run);
        if (id !== run || r === null) return; // cancelled, which already made it idle
        const box = typeof r === "string" ? null : spansBox(r.spans);
        if (typeof r === "string" || !box) { idle(); d.say(r === "same" ? MESSAGES.fillSame : MESSAGES.fillNodata); return; }
        const stroke = d.history.begin();
        // busy until it lands, so a second click never reads tiles this one is about to change
        d.push({ spans: r.spans, box, value, erase: false, stroke, done: (how) => {
          if (id !== run) return;
          idle();
          if (how === "ok") d.say(r.clipped ? MESSAGES.fillClipped(r.pixels) : MESSAGES.filled(r.pixels));
        } });
        d.history.end(stroke);
        d.filled();
      } catch (e) {
        if (id !== run) return;
        idle();
        d.error(e);
      }
    },
    /** Drops a fill still reading (the mode changed or a raster opened); one already queued still lands. */
    cancel(): void { run++; idle(); },
    /** A fill is being read or applied. */
    busy: () => busy,
  };
}
