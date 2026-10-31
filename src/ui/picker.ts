import type { LabelClass } from "../core/classes";
import { tileKeys, tileWindow } from "../core/labelStore";
import { labelAt } from "../core/pick";
import { errorText, MESSAGES, type MessageKind } from "./messages";

type Deps = {
  /** The effective tile at key: stored, else the mask's (read on demand); null when neither exists. */
  tile: (key: string) => Promise<Uint8Array | null>;
  dims: () => { width: number; height: number };
  classes: () => LabelClass[];
  select: (i: number) => void;
  say: (text: string, kind?: MessageKind) => void;
};

/** The class picker (spec 038): selects the class of the label at a raster pixel; a newer pick drops one still reading; a failed read says why. */
export function initPicker({ tile, dims, classes, select, say }: Deps) {
  let latest = 0;
  const pick = async (cell: [number, number] | null): Promise<void> => {
    if (!cell) return; // the I key off the raster
    const id = ++latest, [col, row] = cell;
    const key = tileKeys({ x0: col, y0: row, width: 1, height: 1 })[0]!;
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    let t: Uint8Array | null;
    try { t = await tile(key); } catch (e) {
      if (id === latest) say(errorText(e), "error"); // callers don't await a pick, so it never rejects
      return;
    }
    if (id !== latest) return;
    const v = t ? labelAt(t, tileWindow(dims(), x0, y0), col, row) : 0;
    const c = v > 0 ? classes()[v - 1] : undefined;
    if (!c) { say(v > 0 ? MESSAGES.noClass(v) : MESSAGES.noLabel, "info"); return; }
    select(v - 1);
    say(MESSAGES.picked(c.name), "info");
  };
  return {
    pick,
    /** A pick still reading ends silently, even if its read then fails (spec 039: the raster or class list changed). */
    cancel(): void { latest++; },
  };
}
