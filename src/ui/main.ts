import "./style.css";
import { PREVIEW_MAX_SIDE } from "../core/maskPreview";
import { openFile } from "../io/geotiffSource";
import { buildPreview, openRaster } from "../io/pipeline";
import type { RasterSource } from "../io/source";
import { createMap } from "../map/map";
import { createNavigation } from "../map/navigation";
import { fitToPreview, showPreview } from "../map/preview";
import { initImagery } from "./imagery";
import { inTextField } from "./labelKeys";
import { openSessionStore } from "../io/session";
import { initLabels } from "./labels";
import { errorText, MESSAGES } from "./messages";
import { initProgress } from "./progress";
import { initPersist } from "./persist";
import { initSeeding } from "./seeding";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const say = (text: string) => { message.textContent = text; };

const map = createMap($("map"));
// nav exists before any map event; a held pan key holds tile updates until it settles (spec 027)
const fullRes = initImagery(map, say, { moving: () => nav.moving() });
let source: RasterSource | undefined;
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
const labels = initLabels({ map, say, onBusy: () => seeding.sync(), onChange: () => seeding.sync(), panning: () => nav.panning(),
  imageryBusy: fullRes.busy, mapMoving: fullRes.moving, importing: () => seeding.seeding() || hookValue("pauseMasks") === true,
  sweep: () => hookValue("sweep") !== false, op: (o) => testHook("paintOp", o),
  edits: { tiles: (k) => persist.tiles(k), record: () => persist.record(), replaced: () => persist.replaced(), strokeEnded: () => persist.strokeEnded() } });
// Spec 031: labels are kept in this browser as they change, and offered back when the raster is opened again
const persist = initPersist({ labels, open: openSessionStore, state: $("save-state"), win: window, doc: document,
  confirm: (t) => confirm(t), persistStorage: () => { void navigator.storage?.persist?.(); } });
const seeding = initSeeding({ labels, imagery: () => source, say, error: errorText,
  opened: (f) => testHook("labelFile", f), imported: (f) => persist.imported(f) });
// letters type in text fields and pick options in selects, so WASD leaves them alone (spec 009)
const nav = createNavigation(map, { typing: (el) => inTextField(el) || el instanceof HTMLSelectElement, stroking: labels.stroking });
nav.onSettle(fullRes.settle);

map.on("load", () => {
  // Test hook for e2e (specs 001-014; labels.tile(key) is the effective tile); exposes no user data beyond this page. labelFile: set by a test to see opened label files;
  // rasterFile: set by a test to see (and wrap the reads of) each opened raster before its preview is built; fullRes: spec 020's block limit, which a test may lower before an open.
  // Spec 023: masksDone() says every valid mask is read; a test may set sweep = false (one op per stroke cell), paintOp to see each op,
  // and pauseMasks = true to hold the background mask reads, so strokes wait on reads it gates.
  // Spec 031: persistTiles(keys) marks stored tiles a test or perf run set through the hook as changed.
  const hook = { map, imagery: () => source ?? null, labelFile: null, rasterFile: null, fullRes: fullRes.limits, masksDone: labels.masksDone, sweep: true, paintOp: null, pauseMasks: false,
    persistTiles: (keys: string[]) => persist.tiles(keys) };
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
    say(errorText(e));
  }
}

$<HTMLInputElement>("open-raster").addEventListener("change", (ev) => {
  const req = ++opens;
  let s: RasterSource | undefined;
  // until it opens, a newer open that opened supersedes it; once open, any raster opened after it does
  const stale = () => (s ? source !== s : opened > req);
  return run(async () => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    say("");
    progress.busy();
    const f = await openFile(file);
    if (stale()) return;
    await openRaster(f);
    if (stale()) return;
    // only a raster that opens can discard the labels; Cancel keeps everything
    if (labels.hasLabels() && !confirm(MESSAGES.discard)) { input.value = ""; progress.hide(); return; }
    // spec 031 scope 8: a previous raster's unsaved snapshot asks first; Cancel keeps this raster open. Then the
    // old raster's changes are copied, before labels.open switches the labels
    if (!persist.open(file.name, file.size, f.meta)) { input.value = ""; progress.hide(); return; }
    opened = req;
    source = s = f;
    fullRes.clear();
    previewing?.abort(); // the replaced raster's preview reads stop
    const signal = (previewing = new AbortController()).signal;
    labels.open(f);
    const { width, height, bandCount, epsg } = f.meta;
    $("raster-info").textContent = `${file.name}: ${width} x ${height}, ${bandCount} band(s), EPSG:${epsg}`;
    testHook("rasterFile", f);
    say(MESSAGES.buildingPreview);
    const preview = await buildPreview(f, PREVIEW_MAX_SIDE, { signal, onProgress: (done, total) => {
      if (stale()) return;
      if (done < total) progress.step(done, total);
      else { progress.busy(); say(MESSAGES.drawingPreview); } // the warp, which isn't counted
    } });
    if (stale()) return;
    showPreview(map, preview);
    fitToPreview(map, preview.corners);
    const off = fullRes.open(f, preview.ranges);
    labels.imageryReady(true);
    progress.hide();
    say(off ? `Raster opened. ${off}` : "Raster opened.");
    labels.startMasks(); // spec 023 F3: only after the open, and behind the visible tiles
    // spec 031: once the preview is drawn; a store that can't open shows on #save-state when a save fails
    persist.offer().then((m) => { if (m && !stale()) say(m); }, () => {});
  }, stale);
});

