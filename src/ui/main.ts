import "./style.css";
import { PREVIEW_MAX_SIDE } from "../core/maskPreview";
import { openFile } from "../io/geotiffSource";
import { buildPreview, openRaster, RasterRefusedError } from "../io/pipeline";
import type { RasterSource } from "../io/source";
import { createMap } from "../map/map";
import { createNavigation } from "../map/navigation";
import { fitToPreview, showPreview } from "../map/preview";
import { initLabels, inTextField } from "./labels";
import { MESSAGES } from "./messages";
import { initSeeding } from "./seeding";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = $("message");
const say = (text: string) => { message.textContent = text; };

const map = createMap($("map"));
let source: RasterSource | undefined;
// Opens are numbered so that an older open finishing late can't replace the raster a newer one opened
let opens = 0;
let opened = 0;

/** An action's error as shown to the user. */
const errorText = (e: unknown) => (e instanceof RasterRefusedError && e.reason === "antimeridian" ? MESSAGES.rasterAntimeridian : (e as Error).message);

// The labels' callbacks run only after the user acts, by when seeding exists.
const labels = initLabels({ map, say, onBusy: () => seeding.sync(), onChange: () => seeding.sync(), panning: () => nav.panning() });
const seeding = initSeeding({ labels, imagery: () => source, say, error: errorText,
  opened: (f) => { const h = (window as unknown as { __geoapp?: { labelFile?: unknown } }).__geoapp?.labelFile; if (typeof h === "function") h(f); } });
// letters type in text fields and pick options in selects, so WASD leaves them alone (spec 009)
const nav = createNavigation(map, { typing: (el) => inTextField(el) || el instanceof HTMLSelectElement, stroking: labels.stroking });

map.on("load", () => {
  // Test hook for e2e (specs 001-014; labels.tile(key) is the effective tile); exposes no user data beyond this page. labelFile: set by a test to see opened label files.
  const hook = { map, imagery: () => source ?? null, labelFile: null };
  Object.defineProperty(hook, "labels", { get: () => ({ store: labels.store(), classes: labels.classes(), tile: labels.tile }) });
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
    await openRaster(f);
    if (stale()) return;
    // only a raster that opens can discard the labels; Cancel keeps everything
    if (labels.hasLabels() && !confirm(MESSAGES.discard)) { input.value = ""; return; }
    opened = req;
    source = s = f;
    labels.open(f);
    const { width, height, bandCount, epsg } = f.meta;
    $("raster-info").textContent = `${file.name}: ${width} x ${height}, ${bandCount} band(s), EPSG:${epsg}`;
    const preview = await buildPreview(f, PREVIEW_MAX_SIDE);
    if (stale()) return;
    showPreview(map, preview);
    fitToPreview(map, preview.corners);
    say("Raster opened.");
  }, stale);
});

