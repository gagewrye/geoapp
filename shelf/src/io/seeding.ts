// Fragment of src/io/seeding.ts (spec 013): merge seedModel back by hand, with these imports. build and
// anyNonZero copy that module's private helpers; Labels, SeedMode and SeedOutcome are its types, and
// SeedOutcome must regain "bad names" (spec 013 dropped it with seedModel).
import { badClassName } from "../core/classes";
import { mergeClasses } from "../core/classTable";
import { tileWindows, type Window } from "../core/grid";
import { emptyStore, putTile, type LabelStore } from "../core/labelStore";
import { seedFromModel } from "../core/predict";
import { maskNodata, mergeTile } from "../core/seed";
import type { Model } from "../core/types";
import type { RasterSource } from "./source";

/** Builds new labels from per-window seeds (null when a window seeds nothing) without touching `current`. */
// Leaving `current` alone lets a stale or failed run change nothing: Merge starts from a shallow copy
// of its store and list, Replace from neither. Each seeded window's tile becomes mergeTile(old, seed).
async function build(windows: Window[], current: Labels, mode: SeedMode, incoming: { name: string; colour?: string }[],
  seed: (w: Window, values: number[]) => Promise<Uint8Array | null>, stale: () => boolean): Promise<SeedOutcome> {
  const merged = mergeClasses(mode === "merge" ? current.classes : [], incoming);
  if (merged === "too many") return merged;
  const { width, height } = current.store;
  const store: LabelStore = mode === "merge" ? { width, height, tiles: new Map(current.store.tiles) } : emptyStore(width, height);
  let pixels = 0;
  const seen = new Set<number>();
  for (const w of windows) {
    const s = await seed(w, merged.values);
    if (stale()) return "stale";
    if (!s) continue;
    const old = store.tiles.get(`${w.x0},${w.y0}`);
    for (let i = 0; i < s.length; i++) if (s[i] && !old?.[i]) { pixels++; seen.add(s[i]!); }
    if (putTile(store, w, mergeTile(old, s)) === "full") return "full";
  }
  if (!pixels) return "empty";
  return { store, classes: merged.list, pixels, classCount: seen.size };
}

const anyNonZero = (a: Uint8Array) => a.some((v) => v !== 0);

/** Seeds labels from a model's predictions where its max softmax is at least minProb, masked by imagery nodata (spec 004). */
// Every imagery window is read once; the incoming classes are model.classes, without colours.
// A model whose names spec 003 refuses reads nothing: its list wouldn't export and import back the same.
export async function seedModel(imagery: RasterSource, model: Model, minProb: number, current: Labels,
  mode: SeedMode, stale: () => boolean = () => false): Promise<SeedOutcome> {
  if (badClassName(model.classes) !== null) return "bad names";
  const { width, height } = imagery.meta;
  return build(tileWindows(width, height), current, mode, model.classes.map((name) => ({ name })), async (w, values) => {
    const tile = await imagery.readWindow(w.x0, w.y0, w.width, w.height);
    const labels = seedFromModel(model, tile, minProb, values);
    maskNodata(tile, labels);
    return anyNonZero(labels) ? labels : null;
  }, stale);
}
