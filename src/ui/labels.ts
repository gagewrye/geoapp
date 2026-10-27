import type { Map as MapLibreMap } from "maplibre-gl";
import { MAX_CLASSES, checkName, initialClasses, nextClass, type LabelClass } from "../core/classes";
import type { Window } from "../core/grid";
import { emptyStore, paintedValues, tileKeys, type LabelStore } from "../core/labelStore";
import { BRUSH_SIZES, DEFAULT_BRUSH } from "../core/pixel";
import { PaintQueue } from "../io/paintQueue";
import type { RasterSource } from "../io/source";
import { createBrush, type BrushMode } from "../map/brush";
import { LabelOverlays } from "../map/labelOverlay";
import { markSelected, renderClasses } from "./classList";
import { MESSAGES } from "./messages";

type Deps = {
  map: MapLibreMap;
  say: (text: string) => void;
  /** The paint queue became busy or idle (Train is disabled while it is busy). */
  onBusy: () => void;
  /** Paint mode was chosen: the AlphaEarth area tool must stop (ADR 0009). */
  onPaint: () => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "color", "file", "range", "image"]);
const inTextField = (el: Element | null) => el instanceof HTMLTextAreaElement
  || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);
// Space activates a focused control natively (keyboard users press buttons with it), so it pans only elsewhere
const onControl = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
  || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement || (el instanceof HTMLElement && el.isContentEditable);

/** Brush labels on local imagery (spec 003): panel, classes, shortcuts, store, paint queue and overlays. */
export function initLabels({ map, say, onBusy, onPaint }: Deps) {
  const panel = $("brush-panel"), list = $("classes"), add = $<HTMLButtonElement>("class-add"), sizeText = $("brush-size");
  const classes: LabelClass[] = initialClasses();
  let selected = 0;
  let size = BRUSH_SIZES.indexOf(DEFAULT_BRUSH);
  let open = false;
  let store: LabelStore = emptyStore(0, 0);
  let queue: PaintQueue | null = null;
  let overlays: LabelOverlays | null = null;
  const dirty = new Set<string>();
  let frame = 0;

  const brush = createBrush(map, {
    side: () => BRUSH_SIZES[size]!,
    colour: () => classes[selected]!.colour,
    cells: (ws, erase) => { for (const w of ws) queue?.push({ w, value: selected + 1, erase }); },
  });

  // A redraw walks a whole tile, so tiles changed by many cells are redrawn once per frame.
  const flush = () => {
    frame = 0;
    const colours = classes.map((c) => c.colour);
    for (const key of dirty) overlays?.update(key, store.tiles.get(key), colours);
    dirty.clear();
  };
  const redraw = (keys: Iterable<string>) => {
    for (const k of keys) dirty.add(k);
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const setMode = (m: BrushMode) => {
    brush.setMode(m);
    $("mode-paint").setAttribute("aria-pressed", String(m === "paint"));
    $("mode-pan").setAttribute("aria-pressed", String(m === "pan"));
    if (m === "paint") onPaint();
  };
  const step = (d: number) => {
    size = Math.max(0, Math.min(BRUSH_SIZES.length - 1, size + d));
    sizeText.textContent = `Brush: ${BRUSH_SIZES[size]} px`;
    brush.refresh();
  };
  const select = (i: number) => {
    selected = i;
    markSelected(list, i);
    brush.refresh();
  };
  const render = () => {
    renderClasses(list, classes, selected, {
      select,
      rename: (i, name) => {
        const ok = checkName(classes, i, name);
        if (ok === null) { say(MESSAGES.className); return classes[i]!.name; }
        classes[i]!.name = ok;
        return ok;
      },
      recolour: (i, colour) => {
        classes[i]!.colour = colour;
        redraw(store.tiles.keys());
        brush.refresh();
      },
    });
    add.disabled = classes.length >= MAX_CLASSES;
  };
  render();

  $("mode-paint").addEventListener("click", () => setMode("paint"));
  $("mode-pan").addEventListener("click", () => setMode("pan"));
  $("brush-smaller").addEventListener("click", () => step(-1));
  $("brush-larger").addEventListener("click", () => step(1));
  add.addEventListener("click", () => {
    if (classes.length >= MAX_CLASSES) return;
    classes.push(nextClass(classes));
    render();
  });
  window.addEventListener("keydown", (e) => {
    if (!open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") {
      if (!onControl(document.activeElement)) { e.preventDefault(); brush.setSpace(true); }
      return;
    }
    if (inTextField(document.activeElement)) return;
    if (e.key === "[") step(-1);
    else if (e.key === "]") step(1);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= classes.length) select(Number(e.key) - 1);
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    if (open && !onControl(document.activeElement)) e.preventDefault();
    brush.setSpace(false);
  });

  return {
    /** Start labelling newly opened local imagery: an empty store, no masks, Paint mode. */
    open(source: RasterSource): void {
      queue?.clear();
      overlays?.clear();
      dirty.clear();
      const { width, height, epsg, gt } = source.meta;
      const grid = { width, height, epsg, gt };
      store = emptyStore(width, height);
      queue = new PaintQueue(source, () => store, {
        applied: (w: Window) => redraw(tileKeys(w)),
        full: () => say(MESSAGES.labelLimit),
        busy: onBusy,
        error: (e) => say((e as Error).message),
      });
      overlays = new LabelOverlays(map, grid);
      open = true;
      panel.hidden = false;
      brush.setImagery(grid);
      setMode("paint");
    },
    setMode,
    /** True when any pixel is labelled (no all-zero tile is kept). */
    hasLabels: () => store.tiles.size > 0,
    /** Stroke cells are waiting for nodata masks. */
    busy: () => (queue?.size ?? 0) > 0,
    store: () => store,
    classes: () => classes,
    /** Classes with painted pixels. */
    paintedClasses: () => [...paintedValues(store)].filter((v) => v <= classes.length).length,
  };
}
