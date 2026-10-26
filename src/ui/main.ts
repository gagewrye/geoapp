import "./style.css";
import type { TerraDraw } from "terra-draw";
import { labelFeatures } from "../core/labels";
import { parseModel, serializeModel } from "../core/modelio";
import type { Model } from "../core/types";
import { openFile } from "../io/geotiffSource";
import { buildPreview, checkClassify, classify, openRaster, RasterRefusedError, train } from "../io/pipeline";
import { downloadBlob, openSink } from "../io/sink";
import type { RasterSource } from "../io/source";
import { createDraw } from "../map/draw";
import { createMap } from "../map/map";
import { fitToPreview, showPreview } from "../map/preview";
import { initAef, type AefState } from "./aef";
import { MESSAGES } from "./messages";
import { renderPolygonList } from "./polygonList";

const PREVIEW_MAX_SIDE = 1024;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const say = (text: string) => { message.textContent = text; };

const map = createMap($("map"));
let draw: TerraDraw | undefined;
let source: RasterSource | undefined;
let model: Model | undefined;

/** Train and Classify work on local imagery only: off while AlphaEarth is in use without it (spec 002). */
function lockModel(aef: AefState): void {
  const off = !source && aef !== "none";
  $<HTMLButtonElement>("train").disabled = off;
  $<HTMLButtonElement>("classify").disabled = off;
}

map.on("load", () => {
  // terra-draw also fires "finish" at the end of a blocked drag, so only an unblocked gesture
  // (pointer press or key) clears a block message left over from an earlier edit.
  let blocked = false;
  map.getCanvasContainer().addEventListener("pointerdown", (e) => { if (e.isPrimary) blocked = false; }, { capture: true });
  window.addEventListener("keydown", () => { blocked = false; }, { capture: true }); // Enter finishes a polygon too
  draw = createDraw(map, (reason) => { blocked = true; say(MESSAGES[reason]); });
  const d = draw;
  d.on("finish", (id, ctx) => {
    if (!blocked && (message.textContent === MESSAGES.antimeridian || message.textContent === MESSAGES.latitude)) say("");
    if (ctx.mode === "polygon" && ctx.action === "draw") d.updateFeatureProperties(id, { className: $<HTMLInputElement>("class-name").value.trim() });
    if (ctx.mode === "rectangle" && ctx.action === "draw") aef.areaDrawn(id);
    renderPolygonList($("polygons"), d);
  });
  d.on("change", (_ids, type) => { if (type !== "update") renderPolygonList($("polygons"), d); });
  // Test hook for e2e (spec 001 criteria 12, 14, 15); exposes no user data beyond this page.
  (window as unknown as Record<string, unknown>).__geoapp = { map, draw: d, aef: aef.current };
  $("map").dataset.ready = "true";
});

$("mode-draw").addEventListener("click", () => draw?.setMode("polygon"));
$("mode-select").addEventListener("click", () => draw?.setMode("select"));

const aef = initAef({ map, draw: () => draw, previewMaxSide: PREVIEW_MAX_SIDE, say, run, onState: lockModel });

async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (e) {
    say(e instanceof RasterRefusedError && e.reason === "antimeridian" ? MESSAGES.rasterAntimeridian : (e as Error).message);
  }
}

$<HTMLInputElement>("open-raster").addEventListener("change", (ev) => run(async () => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  say("");
  const s = await openFile(file);
  if (s.aef) return say(MESSAGES.rasterIsAef);
  await openRaster(s);
  source = s;
  lockModel(aef.state());
  const { width, height, bandCount, epsg } = s.meta;
  $("raster-info").textContent = `${file.name}: ${width} x ${height}, ${bandCount} band(s), EPSG:${epsg}`;
  const preview = await buildPreview(s, PREVIEW_MAX_SIDE);
  showPreview(map, preview);
  fitToPreview(map, preview.corners);
  say("Raster opened.");
}));

$("train").addEventListener("click", () => run(async () => {
  if (!source || !draw) return say("Open a raster first.");
  // the AlphaEarth area is a rectangle-mode feature; only drawn polygons are labels
  const { classes, features } = labelFeatures(draw.getSnapshot().filter((f) => f.properties.mode === "polygon"));
  if (classes.length < 2) return say("Draw polygons for at least two classes.");
  if (classes.length > 255) return say("At most 255 classes are supported."); // before sampling; fit checks too
  say("Training...");
  const result = await train(source, features, classes);
  model = result.model;
  say(`Trained on ${result.samples} pixels, ${classes.length} classes.`);
}));

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
