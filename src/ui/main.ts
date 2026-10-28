import "./style.css";
import type { TerraDraw } from "terra-draw";
import { parseModel, serializeModel } from "../core/modelio";
import type { Model } from "../core/types";
import { openFile } from "../io/geotiffSource";
import { buildPreview, checkClassify, classify, openRaster, RasterRefusedError, train } from "../io/pipeline";
import { downloadBlob, openSink } from "../io/sink";
import type { RasterSource } from "../io/source";
import { createDraw } from "../map/draw";
import { createMap } from "../map/map";
import { fitToPreview, showPreview } from "../map/preview";
import { initAef } from "./aef";
import { initLabels } from "./labels";
import { MESSAGES } from "./messages";
import { initSeeding } from "./seeding";

const PREVIEW_MAX_SIDE = 1024;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const say = (text: string) => { message.textContent = text; };

const map = createMap($("map"));
let draw: TerraDraw | undefined;
let source: RasterSource | undefined;
let model: Model | undefined;
let training = false; // one run at a time, so one label snapshot (spec 003 Training) and no older run overwriting a newer one
let classifying = false; // one export at a time: without the Save dialog, every export writes the same OPFS file
// Opens are numbered so that an older open finishing late can't replace the raster a newer one opened
let opens = 0;
let opened = 0;

/** Train and Classify need local imagery (spec 002); Train also waits for pending mask reads and seeding; each waits for its own run (specs 003, 004). */
function lockModel(): void {
  const off = !source && aef.state() !== "none";
  $<HTMLButtonElement>("train").disabled = off || labels.busy() || training || seeding.seeding();
  $<HTMLButtonElement>("classify").disabled = off || classifying;
}

/** An action's error as shown to the user. */
const errorText = (e: unknown) => (e instanceof RasterRefusedError && e.reason === "antimeridian" ? MESSAGES.rasterAntimeridian : (e as Error).message);

// The labels' callbacks run only after the user acts, by when seeding exists.
const labels = initLabels({ map, say, onBusy: () => { lockModel(); seeding.sync(); }, onChange: () => seeding.sync(), onPaint: () => draw?.setMode("static") });
const seeding = initSeeding({ labels, imagery: () => source, model: () => model, training: () => training, say, error: errorText, onBusy: () => lockModel(),
  opened: (f) => { const h = (window as unknown as { __geoapp?: { labelFile?: unknown } }).__geoapp?.labelFile; if (typeof h === "function") h(f); } });
// the area tool and the brush never share the mouse
const aef = initAef({ map, draw: () => draw, previewMaxSide: PREVIEW_MAX_SIDE, say, run, onState: () => lockModel(),
  onAreaTool: () => labels.setMode("pan") });

map.on("load", () => {
  draw = createDraw(map, () => labels.syncHandlers());
  const d = draw;
  d.on("finish", (id, ctx) => { if (ctx.mode === "rectangle" && ctx.action === "draw") aef.areaDrawn(id); });
  // Test hook for e2e (specs 001-004); exposes no user data beyond this page. labelFile: set by a test to see opened label files.
  const hook = { map, draw: d, aef: aef.current, imagery: () => source ?? null, model: () => model ?? null, labelFile: null };
  Object.defineProperty(hook, "labels", { get: () => ({ store: labels.store(), classes: labels.classes() }) });
  (window as unknown as Record<string, unknown>).__geoapp = hook;
  $("map").dataset.ready = "true";
});

/** Runs a UI action, showing its error unless `stale` says the raster it started on was replaced. */
async function run(task: () => Promise<void>, stale = () => false): Promise<void> {
  try {
    await task();
  } catch (e) {
    if (stale()) return;
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
    const f = await openFile(file);
    if (stale()) return;
    if (f.aef) return say(MESSAGES.rasterIsAef);
    await openRaster(f);
    if (stale()) return;
    // only a raster that opens can discard the labels; Cancel keeps everything
    if (labels.hasLabels() && !confirm(MESSAGES.discard)) { input.value = ""; return; }
    opened = req;
    source = s = f;
    labels.open(f);
    lockModel();
    const { width, height, bandCount, epsg } = f.meta;
    $("raster-info").textContent = `${file.name}: ${width} x ${height}, ${bandCount} band(s), EPSG:${epsg}`;
    const preview = await buildPreview(f, PREVIEW_MAX_SIDE);
    if (stale()) return;
    showPreview(map, preview);
    fitToPreview(map, preview.corners);
    say("Raster opened.");
  }, stale);
});

$("train").addEventListener("click", () => {
  if (training || labels.busy()) return; // Train is disabled meanwhile
  training = true;
  lockModel();
  seeding.sync(); // no Import labels or Seed meanwhile
  const s = source;
  // a run on a raster that was replaced meanwhile sets no model and no message
  const stale = () => source !== s;
  return run(async () => {
    try {
      if (!s) return say("Open a raster first.");
      if (labels.paintedClasses() < 2) return say(MESSAGES.paintTwo);
      const names = labels.classes().map((c) => c.name);
      say("Training...");
      const result = await train(s, labels.store(), names);
      if (stale()) return;
      if (result === "no samples") return say(MESSAGES.noSamples);
      model = result.model;
      seeding.sync();
      say(`Trained on ${result.samples} pixels, ${names.length} classes.`);
    } finally {
      training = false; // even a dropped run keeps Train disabled until it ends: one snapshot at a time
      lockModel();
      seeding.sync();
    }
  }, stale);
});

$("classify").addEventListener("click", () => {
  if (classifying) return; // Classify is disabled meanwhile
  classifying = true;
  lockModel();
  return run(async () => {
    try {
      // the raster and model at the click: another raster may open while the Save dialog is up
      const s = source, m = model;
      if (!s) return say("Open a raster first.");
      if (!m) return say("Train or load a model first.");
      checkClassify(s, m); // before the Save dialog, so a rejected export leaves no empty file
      const sink = await openSink("classified.tif"); // a cancelled dialog throws, so finally still runs
      say("Classifying...");
      try {
        await classify(s, m, sink);
      } catch (e) {
        await sink.abort?.().catch(() => {}); // a failed cleanup must not hide the classify error
        throw e;
      }
      say("Export complete.");
    } finally {
      classifying = false;
      lockModel();
    }
  });
});

$("save-model").addEventListener("click", () => {
  if (!model) return say("Train or load a model first.");
  downloadBlob(new Blob([serializeModel(model)], { type: "application/json" }), "model.json");
});

$<HTMLInputElement>("load-model").addEventListener("change", (ev) => run(async () => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!source) return say("Open a raster first.");
  model = parseModel(await file.text(), source.meta.bandCount);
  seeding.sync();
  say(`Loaded model with classes: ${model.classes.join(", ")}.`);
}));
