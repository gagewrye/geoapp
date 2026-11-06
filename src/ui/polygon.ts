import { polygonFits, polygonSpans } from "../core/polygon";
import { spansBox } from "../core/spans";
import type { PaintOp } from "../io/paintQueue";
import type { UndoHistory } from "../io/undoHistory";
import { MESSAGES, type MessageKind } from "./messages";

type Deps = {
  dims: () => { width: number; height: number };
  /** Two raster cells are within a few screen pixels of each other. */
  near: (a: [number, number], b: [number, number]) => boolean;
  /** Draw the outline through these corners, or none. */
  show: (corners: [number, number][] | null) => void;
  /** Queue the fill (spec 023's PaintQueue: nodata and base tiles as for Paint). */
  push: (op: PaintOp) => void;
  history: UndoHistory;
  /** The selected class's label value. */
  value: () => number;
  locked: () => boolean;
  /** A fill was queued as one ended stroke. */
  applied: () => void;
  say: (text: string, kind?: MessageKind) => void;
  /** A millisecond clock (tests); performance.now by default. */
  now?: () => number;
};

/** A press this soon after the click that closed an outline, at the same place, is the same double click. */
const DOUBLE_MS = 500;

/** The Polygon tool's corners (spec 054): clicks add them, and closing the outline fills it with the selected class as one undoable edit. */
export function initPolygon(d: Deps) {
  let corners: [number, number][] = [], committing = false;
  let closed: { cell: [number, number]; at: number } | null = null; // the click that last closed an outline
  const now = d.now ?? (() => performance.now());
  const show = () => d.show(corners.length ? corners : null);
  const drop = () => { if (corners.length) { corners = []; show(); } };

  /** Enter: fills the outline; false when ignored (fewer than 3 corners, a fill still landing, or locked labels). */
  const apply = (): boolean => {
    if (corners.length < 3 || committing || d.locked()) return false;
    const spans = polygonSpans(corners, d.dims()), box = spansBox(spans);
    if (!box) return false;
    committing = true;
    const mine = corners, stroke = d.history.begin();
    d.push({ spans, box, value: d.value(), erase: false, stroke, done: (r) => {
      committing = false;
      if (r === "ok" && corners === mine) drop(); // a dropped fill keeps the outline, to apply again
    } });
    d.history.end(stroke);
    d.applied();
    return true;
  };

  return {
    /** A click on a raster cell adds a corner; on the first or last corner of three or more (a double click) it fills the outline. */
    click(cell: [number, number]): void {
      if (committing) return;
      // a fill that lands at once has cleared the outline before a double click's second press: that press isn't a new corner
      const c = closed;
      closed = null;
      if (c && !corners.length && now() - c.at < DOUBLE_MS && d.near(cell, c.cell)) return;
      const last = corners.at(-1);
      if (corners.length >= 3 && (d.near(cell, corners[0]!) || d.near(cell, last!))) { if (apply()) closed = { cell, at: now() }; return; }
      if (last && d.near(cell, last)) return; // a double click's second press
      if (!polygonFits(corners, cell)) { d.say(MESSAGES.polygonTooLarge); return; }
      corners.push(cell);
      show();
    },
    apply,
    /** Backspace or a right click: removes the last corner; false when there is none. */
    back(): boolean {
      if (!corners.length || committing) return false;
      corners.pop();
      show();
      return true;
    },
    /** Escape: drops the outline; false when there was none. A fill already queued still lands. */
    discard(): boolean {
      if (!corners.length) return false;
      drop();
      return true;
    },
    /** A raster opened: no outline. */
    open(): void { committing = false; closed = null; drop(); },
    /** Draw the outline again (the selected class or its colour changed). */
    redraw: show,
    corners: () => corners.length,
  };
}
