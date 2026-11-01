import type { Window } from "../core/grid";
import { chooseMask, decodeLog, maskBits, maskShare, maskSpans, promptPoints, samWindow, stability } from "../core/smart";
import { spansBox } from "../core/spans";
import type { PaintOp } from "../io/paintQueue";
import type { Segmenter } from "../io/segmenter";
import type { UndoHistory } from "../io/undoHistory";

/** A previewed mask: one bit per pixel of its window. */
export type SmartMask = { bits: Uint8Array; window: Window };

type Deps = {
  dims: () => { width: number; height: number };
  /** The loaded Segmenter, or null before Smart was first chosen. */
  segmenter: () => Segmenter | null;
  /** The encoder tensor of a window of the open raster, as displayed. */
  input: (w: Window, signal: AbortSignal) => Promise<Float32Array>;
  /** Draw the mask in the selected class colour, or none. */
  show: (mask: SmartMask | null) => void;
  /** Queue a fill (spec 023's PaintQueue). */
  push: (op: PaintOp) => void;
  history: UndoHistory;
  /** The selected class's label value. */
  value: () => number;
  locked: () => boolean;
  /** An encode started (true) or the last one running ended (false): the status bar says reading. */
  reading: (on: boolean) => void;
  error: (e: unknown) => void;
};

type Prompt = { window: Window; key: string; points: [number, number][]; labels: number[]; ac: AbortController; encoded: Promise<void> | null; seq: number; committing: boolean };

const inside = (w: Window, [c, r]: [number, number]) => c >= w.x0 && c < w.x0 + w.width && r >= w.y0 && r < w.y0 + w.height;

/** Smart select's prompt (spec 046 scopes 3, 5-7): points in one window, its embedding, the previewed mask, and its commit. */
export function initSmart(d: Deps) {
  let prompt: Prompt | null = null, mask: SmartMask | null = null;
  let raster = 0, encoding = 0; // raster: bumped by open(), so an older raster's embedding is never reused
  // the encode running, whatever its prompt: a prompt in the same window waits for it (Escape mid-encode, then a click)
  let inflight: { key: string; done: Promise<void> } | null = null;
  const setMask = (m: SmartMask | null) => { mask = m; d.show(m); };
  const drop = () => {
    prompt?.ac.abort();
    prompt = null;
    if (mask) setMask(null);
  };

  const encode = (p: Prompt, seg: Segmenter): Promise<void> => {
    const shared = inflight?.key === p.key ? inflight.done : null;
    // a dropped prompt's encode that never reached the worker (its read was aborted) leaves this one to encode
    const done = shared ? shared.catch(() => encodeOwn(p, seg)) : encodeOwn(p, seg);
    const mine = { key: p.key, done };
    inflight = mine;
    void done.catch(() => {}).finally(() => { if (inflight === mine) inflight = null; });
    return done;
  };
  const encodeOwn = async (p: Prompt, seg: Segmenter) => {
    if (encoding++ === 0) d.reading(true);
    try {
      const input = await d.input(p.window, p.ac.signal);
      p.ac.signal.throwIfAborted();
      await seg.encode(input, p.key);
    } finally {
      if (--encoding === 0) d.reading(false);
    }
  };

  // Every click asks for a decode of all the prompt's points; only the newest request's result shows
  const refresh = async (p: Prompt, seg: Segmenter) => {
    const seq = ++p.seq;
    const current = () => p === prompt && seq === p.seq;
    try {
      if (!seg.has(p.key)) {
        p.encoded ??= encode(p, seg).catch((e) => { p.encoded = null; throw e; });
        await p.encoded;
      }
      if (!current()) return;
      const r = await seg.decode(promptPoints(p.points, p.window), Uint8Array.from(p.labels));
      if (!current()) return;
      // the export returns only SAM's three multimask outputs (tokens 1-3), for any point count; IoU alone picks
      // unstable blobs, so the most confident stable one shows (ADR 0032, spec 046 Amendment A)
      const plane = r.side * r.side, planes = [...r.scores].map((_, i) => r.masks.subarray(i * plane, (i + 1) * plane));
      const stab = planes.map((m) => stability(m)), k = chooseMask(r.scores, stab);
      setMask({ bits: maskBits(planes[k]!, r.side, p.window), window: p.window });
      console.info(decodeLog(p.points.length, r.scores, stab, planes.map(maskShare), k));
    } catch (e) {
      if (p === prompt && !p.ac.signal.aborted) d.error(e);
    }
  };

  return {
    /** A left (include) or right (exclude) click on a raster cell; outside the prompt's window it starts a new prompt. */
    click(cell: [number, number], include: boolean): void {
      const seg = d.segmenter();
      if (!seg) return;
      if (!prompt || !inside(prompt.window, cell)) {
        drop();
        const w = samWindow(d.dims(), cell[0], cell[1]);
        prompt = { window: w, key: `${raster}:${w.x0},${w.y0},${w.width},${w.height}`, points: [], labels: [], ac: new AbortController(), encoded: null, seq: 0, committing: false };
      }
      prompt.points.push(cell);
      prompt.labels.push(include ? 1 : 0);
      void refresh(prompt, seg);
    },
    /** Escape: drops a pending prompt; false when there was none. */
    discard(): boolean {
      if (!prompt) return false;
      drop();
      return true;
    },
    /** Enter: fills the shown mask with the selected class as one undoable edit; false when ignored. */
    apply(): boolean {
      const p = prompt;
      if (!p || !mask || p.committing || d.locked()) return false;
      const spans = maskSpans(mask.bits, mask.window), box = spansBox(spans);
      if (!box) return false;
      p.committing = true;
      const stroke = d.history.begin();
      d.push({ spans, box, value: d.value(), erase: false, stroke, done: (r) => {
        p.committing = false;
        if (r === "ok" && p === prompt) drop();
      } });
      d.history.end(stroke);
      return true;
    },
    /** A raster opened: the prompt and the embedding are dropped. */
    open(): void { raster++; drop(); },
    /** Draw the mask again (the selected class or its colour changed). */
    redraw(): void { if (mask) d.show(mask); },
    /** A mask is shown. */
    shown: () => mask !== null,
  };
}
