import "./style.css";
import type { TerraDraw } from "terra-draw";
import { labelFeatures } from "../core/labels";
import { parseModel, serializeModel } from "../core/modelio";
import type { Model } from "../core/types";
import { openFile } from "../io/geotiffSource";
import { buildPreview, classify, openRaster, RasterRefusedError, train } from "../io/pipeline";
import { downloadBlob, openSink } from "../io/sink";
import type { RasterSource } from "../io/source";
import { createDraw } from "../map/draw";
import { createMap } from "../map/map";
import { fitToPreview, showPreview } from "../map/preview";
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

map.on("load", () => {
  draw = createDraw(map, (reason) => say(MESSAGES[reason]));
  const d = draw;
  d.on("finish", (id, ctx) => {
    if (ctx.mode === "polygon" && ctx.action === "draw") d.updateFeatureProperties(id, { className: $<HTMLInputElement>("class-name").value.trim() });
    renderPolygonList($("polygons"), d);
  });
  d.on("change", (_ids, type) => { if (type !== "update") renderPolygonList($("polygons"), d); });
  // Test hook for e2e (spec 001 criteria 12, 14, 15); exposes no user data beyond this page.
  (window as unknown as Record<string, unknown>).__geoapp = { map, draw: d };
  $("map").dataset.ready = "true";
});

$("mode-draw").addEventListener("click", () => draw?.setMode("polygon"));
$("mode-select").addEventListener("click", () => draw?.setMode("select"));

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
  await openRaster(s);
  source = s;
  const { width, height, bandCount, epsg } = s.meta;
  $("raster-info").textContent = `${file.name}: ${width} x ${height}, ${bandCount} band(s), EPSG:${epsg}`;
  const preview = await buildPreview(s, PREVIEW_MAX_SIDE);
  showPreview(map, preview);
  fitToPreview(map, preview.corners);
  say("Raster opened.");
}));

$("train").addEventListener("click", () => run(async () => {
  if (!source || !draw) return say("Open a raster first.");
  const { classes, features } = labelFeatures(draw.getSnapshot());
  if (classes.length < 2) return say("Draw polygons for at least two classes.");
  say("Training...");
  const result = await train(source, features, classes);
  model = result.model;
  say(`Trained on ${result.samples} pixels, ${classes.length} classes.`);
}));

$("classify").addEventListener("click", () => run(async () => {
  if (!source) return say("Open a raster first.");
  if (!model) return say("Train or load a model first.");
  const sink = await openSink("classified.tif");
  say("Classifying...");
  await classify(source, model, sink);
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
