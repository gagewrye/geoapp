import type { LabelClass } from "../core/classes";
import { tileKeys, tileWindow } from "../core/labelStore";
import { labelAt } from "../core/pick";
import { MESSAGES, type MessageKind } from "./messages";

type Deps = {
  /** The effective tile at key: stored, else the mask's (read on demand); null when neither exists. */
  tile: (key: string) => Promise<Uint8Array | null>;
  dims: () => { width: number; height: number };
  classes: () => LabelClass[];
  select: (i: number) => void;
  say: (text: string, kind?: MessageKind) => void;
};

/** The class picker (spec 038): selects the class of the label at a raster pixel; a newer pick drops one still reading. */
export function initPicker({ tile, dims, classes, select, say }: Deps) {
  let latest = 0;
  return async (cell: [number, number] | null): Promise<void> => {
    if (!cell) return; // the I key off the raster
    const id = ++latest, [col, row] = cell;
    const key = tileKeys({ x0: col, y0: row, width: 1, height: 1 })[0]!;
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    const t = await tile(key);
    if (id !== latest) return;
    const v = t ? labelAt(t, tileWindow(dims(), x0, y0), col, row) : 0;
    const c = v > 0 ? classes()[v - 1] : undefined;
    if (!c) { say(MESSAGES.noLabel, "info"); return; }
    select(v - 1);
    say(MESSAGES.picked(c.name), "info");
  };
}
