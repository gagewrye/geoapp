import "./style.css";
import { PREVIEW_MAX_SIDE } from "../core/maskPreview";
import { canPickFiles, pickRaster } from "../io/filePick";
import { openFile } from "../io/geotiffSource";
import { buildPreview, openRaster } from "../io/pipeline";
import { readSamInput } from "../io/samImagery";
import type { Segmenter } from "../io/segmenter";
import type { ImagerySource, RasterSource } from "../io/source";
import { createMap } from "../map/map";
import { createNavigation } from "../map/navigation";
import { fitRaster, previewBounds, showPreview, type Bounds } from "../map/preview";
import { initImagery } from "./imagery";
import { inTextField } from "./labelKeys";
import { openSessionStore } from "../io/session";
import { initLabels } from "./labels";
import { initHelp } from "./help";
import { initLayout } from "./layout";
import { errorText, MESSAGES, messageSink } from "./messages";
import { initProgress } from "./progress";
import { initPersist } from "./persist";
import { initSeeding } from "./seeding";
import { initSmartLoad } from "./smartLoad";
import { initStatus } from "./status";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const say = messageSink($("message")); // only errors show in red (spec 032)

// the drawn raster's bounds, which Home and the ⌂ button fit again (spec 035)
let bounds: Bounds | null = null;
const home = () => { if (bounds) fitRaster(map, bounds); };
const map = createMap($("map"), home);
const layout = initLayout({ map, open: () => source !== undefined });
initHelp({ dialog: $<HTMLDialogElement>("help"), button: $<HTMLButtonElement>("help-button"), list: $("help-list") }); // works before an open (spec 039)
// text fields, selects, sliders and number fields keep their own Home (specs 036, 037); a checkbox or button doesn't
const ownsHome = (el: Element | null) => inTextField(el) || el instanceof HTMLSelectElement
  || (el instanceof HTMLInputElement && (el.type === "range" || el.type === "number"));
window.addEventListener("keydown", (e) => {
  if (e.key !== "Home" || !bounds || e.ctrlKey || e.metaKey || e.altKey || ownsHome(document.activeElement)) return;
  e.preventDefault();
  home();
});
// the status bar's raster fields stay blank until a raster opens (spec 032)
const status = initStatus(map, () => (source ? source.meta : null));
// nav and labels exist before any map event; a held pan key holds tile updates until it settles (spec 027)
const fullRes = initImagery(map, say, { moving: () => nav.moving(), viewSettled: () => labels.viewSettled() });
let source: RasterSource | undefined;
// the open raster's file handle, so Export's Save dialog and Import labels' picker start in its folder; null when it came through the input (specs 050, 053)
let folder: FileSystemFileHandle | null = null;
// Opens are numbered so that an older open finishing late can't replace the raster a newer one opened
let opens = 0;
let opened = 0;

const progress = initProgress($<HTMLProgressElement>("open-progress"));
let previewing: AbortController | null = null; // the opened raster's preview reads

/** Calls the e2e hook `name` with `arg`, if a test set one. */
const testHook = (name: string, arg: unknown) => {
  const h = (window as unknown as { __geoapp?: Record<string, unknown> }).__geoapp?.[name];
  if (typeof h === "function") h(arg);
};

// The labels' callbacks run only after the user acts, by when seeding exists.
const hookValue = (name: string) => (window as unknown as { __geoapp?: Record<string, unknown> }).__geoapp?.[name];
// Smart select (spec 046) reads the imagery in the preview's colours, so the model sees what the user sees
let ranges: [number, number][] = [];
const smartLoad = initSmartLoad({ hook: () => (hookValue("segmenter") as Segmenter | null | undefined) ?? null, confirm: (t) => confirm(t),
  alert: (t) => alert(t), log: (e) => console.error("Smart select:", e), progress, cancel: $<HTMLButtonElement>("smart-cancel") });
const labels = initLabels({ map, say, toolChanged: () => queueMicrotask(() => status.tool(labels.tool())), // deferred: initLabels calls it before `labels` is assigned
  onBusy: () => seeding.sync(), onChange: () => seeding.sync(), panning: () => nav.panning(),
  imageryBusy: fullRes.busy, mapMoving: fullRes.moving, importing: () => seeding.seeding() || hookValue("pauseMasks") === true,
  sweep: () => hookValue("sweep") !== false, op: (o) => testHook("paintOp", o),
  smart: { load: smartLoad, input: (w, signal) => readSamInput(source as ImagerySource, w, ranges, signal) },
  edits: { tiles: (k) => persist.tiles(k), record: () => persist.record(), replaced: () => persist.replaced(), strokeEnded: () => persist.strokeEnded() } });
// Spec 031: labels are kept in this browser as they change, and offered back when the raster is opened again
const persist = initPersist({ labels, open: openSessionStore, state: $("save-state"), win: window, doc: document,
  confirm: (t) => confirm(t), persistStorage: () => { void navigator.storage?.persist?.(); } });
const seeding = initSeeding({ labels, imagery: () => source, folder: () => folder, say, error: errorText,
  opened: (f) => testHook("labelFile", f), imported: (f) => persist.imported(f) });
// letters type in text fields and pick options in selects, so WASD leaves them alone (spec 009)
const nav = createNavigation(map, { typing: (el) => inTextField(el) || el instanceof HTMLSelectElement, stroking: labels.stroking });
nav.onSettle(fullRes.settle);

map.on("load", () => {
  // Test hook for e2e (specs 001-014; labels.tile(key) is the effective tile); exposes no user data beyond this page. labelFile: set by a test to see opened label files;
  // rasterFile: set by a test to see (and wrap the reads of) each opened raster before its preview is built; fullRes: spec 020's block limit, which a test may lower before an open.
  // Spec 023: masksDone() says every valid mask is read; a test may set sweep = false (one op per stroke cell), paintOp to see each op,
  // and pauseMasks = true to hold the background mask reads, so strokes wait on reads it gates.
  // Spec 031: persistTiles(keys) marks stored tiles a test or perf run set through the hook as changed. Spec 046: segmenter replaces the model.
  const hook = { map, imagery: () => source ?? null, labelFile: null, rasterFile: null, fullRes: fullRes.limits, masksDone: labels.masksDone, sweep: true, paintOp: null, pauseMasks: false,
    persistTiles: (keys: string[]) => persist.tiles(keys), segmenter: null };
  Object.defineProperty(hook, "labels", { get: () => ({ store: labels.store(), classes: labels.classes(), tile: labels.tile }) });
  (window as unknown as Record<string, unknown>).__geoapp = hook;
  $("map").dataset.ready = "true";
});

/** Runs an open, showing its error and ending its progress unless `stale` says a newer open replaced it. */
async function run(task: () => Promise<void>, stale = () => false): Promise<void> {
  try {
    await task();
  } catch (e) {
    if (stale()) return;
    progress.hide();
    say(errorText(e), "error");
  }
}

type Chosen = { file: File; handle: FileSystemFileHandle | null } | null;
const openInput = $<HTMLInputElement>("open-raster");
openInput.addEventListener("change", () => {
  const file = openInput.files?.[0];
  return openChosen(async () => (file ? { file, handle: null } : null));
});
// Spec 050: on Chromium the picker replaces the input's chooser (a label click reaches the input too), so the raster comes with a handle
openInput.addEventListener("click", (e) => {
  if (!canPickFiles()) return;
  e.preventDefault();
  const picked = pickRaster(); // within the click: the picker needs its user activation, so nothing is awaited first
  return openChosen(async () => {
    const handle = await picked; // null when cancelled: nothing opens and nothing shows
    return handle ? { file: await handle.getFile(), handle } : null;
  });
});

/** Opens the raster `choose` gives; its handle replaces `folder` only once the raster replaces `source`. */
function openChosen(choose: () => Promise<Chosen>): Promise<void> {
  const req = ++opens;
  let s: RasterSource | undefined;
  // until it opens, a newer open that opened supersedes it; once open, any raster opened after it does
  const stale = () => (s ? source !== s : opened > req);
  return run(async () => {
    const chosen = await choose();
    if (!chosen) return;
    const { file, handle } = chosen;
    say("");
    progress.busy();
    const f = await openFile(file);
    if (stale()) return;
    await openRaster(f);
    if (stale()) return;
    // only a raster that opens can close the labels; Cancel keeps everything. A previous raster's unsaved snapshot
    // asks instead of the close question (specs 031 scope 8, 032 scope 6). Then the old raster's changes are
    // copied, before labels.open switches the labels
    if (!persist.open(file.name, file.size, f.meta, labels.hasLabels())) { openInput.value = ""; progress.hide(); return; }
    opened = req;
    source = s = f;
    folder = handle;
    fullRes.clear();
    previewing?.abort(); // the replaced raster's preview reads stop
    const signal = (previewing = new AbortController()).signal;
    labels.open(f);
    layout.opened();
    bounds = null; // until this raster's preview is drawn
    const { width, height, bandCount, epsg } = f.meta;
    const info = $("raster-info");
    info.textContent = info.title = `${file.name}: ${width} x ${height}, ${bandCount} band(s), EPSG:${epsg}`; // one line, ellipsised
    testHook("rasterFile", f);
    say(MESSAGES.buildingPreview);
    const preview = await buildPreview(f, PREVIEW_MAX_SIDE, { signal, onProgress: (done, total) => {
      if (stale()) return;
      if (done < total) progress.step(done, total);
      else { progress.busy(); say(MESSAGES.drawingPreview); } // the warp, which isn't counted
    } });
    if (stale()) return;
    showPreview(map, preview);
    fitRaster(map, bounds = previewBounds(preview.corners));
    ranges = preview.ranges;
    const off = fullRes.open(f, preview.ranges);
    labels.imageryReady(true);
    progress.hide();
    // the large-blocks notice is an error (spec 032)
    say(off ? `Raster opened. ${off}` : "Raster opened.", off ? "error" : "info");
    status.refresh();
    labels.startMasks(); // spec 023 F3: only after the open, and behind the visible tiles
    // spec 031: once the preview is drawn; a store that can't open shows on #save-state when a save fails
    persist.offer().then((m) => { if (m && !stale()) say(m); }, () => {});
  }, stale);
}

