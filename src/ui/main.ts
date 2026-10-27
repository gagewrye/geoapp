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

const PREVIEW_MAX_SIDE = 1024;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const say = (text: string) => { message.textContent = text; };

const map = createMap($("map"));
let draw: TerraDraw | undefined;
let source: RasterSource | undefined;
let model: Model | undefined;
let training = false; // one run at a time, so one label snapshot (spec 003 [C5]) and no older run overwriting a newer one

/** Train and Classify need local imagery (spec 002); Train also waits for pending mask reads and its own run (spec 003). */
function lockModel(): void {
  const off = !source && aef.state() !== "none";
  $<HTMLButtonElement>("train").disabled = off || labels.busy() || training;
  $<HTMLButtonElement>("classify").disabled = off;
}

const labels = initLabels({ map, say, onBusy: () => lockModel(), onPaint: () => draw?.setMode("static") });
const aef = initAef({ map, draw: () => draw, previewMaxSide: PREVIEW_MAX_SIDE, say, run, onState: () => lockModel() });
$("aef-draw").addEventListener("click", () => labels.setMode("pan")); // the area tool and the brush never share the mouse

map.on("load", () => {
  draw = createDraw(map);
  const d = draw;
  d.on("finish", (id, ctx) => { if (ctx.mode === "rectangle" && ctx.action === "draw") aef.areaDrawn(id); });
  // Test hook for e2e (specs 001-003); exposes no user data beyond this page.
  const hook = { map, draw: d, aef: aef.current, imagery: () => source ?? null };
  Object.defineProperty(hook, "labels", { get: () => ({ store: labels.store(), classes: labels.classes() }) });
  (window as unknown as Record<string, unknown>).__geoapp = hook;
  $("map").dataset.ready = "true";
});

async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (e) {
    say(e instanceof RasterRefusedError && e.reason === "antimeridian" ? MESSAGES.rasterAntimeridian : (e as Error).message);
  }
}

$<HTMLInputElement>("open-raster").addEventListener("change", (ev) => run(async () => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  say("");
  const s = await openFile(file);
  if (s.aef) return say(MESSAGES.rasterIsAef);
  await openRaster(s);
  // only a raster that opens can discard the labels; Cancel keeps everything
  if (labels.hasLabels() && !confirm(MESSAGES.discard)) { input.value = ""; return; }
  source = s;
  labels.open(s);
  lockModel();
  const { width, height, bandCount, epsg } = s.meta;
  $("raster-info").textContent = `${file.name}: ${width} x ${height}, ${bandCount} band(s), EPSG:${epsg}`;
  const preview = await buildPreview(s, PREVIEW_MAX_SIDE);
  showPreview(map, preview);
  fitToPreview(map, preview.corners);
  say("Raster opened.");
}));

$("train").addEventListener("click", () => {
  if (training || labels.busy()) return; // Train is disabled meanwhile
  training = true;
  lockModel();
  return run(async () => {
    try {
      if (!source) return say("Open a raster first.");
      if (labels.paintedClasses() < 2) return say(MESSAGES.paintTwo);
      const names = labels.classes().map((c) => c.name);
      say("Training...");
      const result = await train(source, labels.store(), names);
      if (result === "no samples") return say(MESSAGES.noSamples);
      model = result.model;
      say(`Trained on ${result.samples} pixels, ${names.length} classes.`);
    } finally {
      training = false;
      lockModel();
    }
  });
});

$("classify").addEventListener("click", () => run(async () => {
  if (!source) return say("Open a raster first.");
  if (!model) return say("Train or load a model first.");
  checkClassify(source, model); // before the Save dialog, so a rejected export leaves no empty file
  const sink = await openSink("classified.tif");
  say("Classifying...");
  try {
    await classify(source, model, sink);
  } catch (e) {
    await sink.abort?.().catch(() => {}); // a failed cleanup must not hide the classify error
    throw e;
  }
  say("Export complete.");
}));

$("save-model").addEventListener("click", () => {
  if (!model) return say("Train or load a model first.");
  downloadBlob(new Blob([serializeModel(model)], { type: "application/json" }), "model.json");
});

$<HTMLInputElement>("load-model").addEventListener("change", (ev) => run(async () => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!source) return say("Open a raster first.");
  model = parseModel(await file.text(), source.meta.bandCount);
  say(`Loaded model with classes: ${model.classes.join(", ")}.`);
}));
