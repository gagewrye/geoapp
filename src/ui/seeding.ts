import { ClassTableError } from "../core/classTable";
import type { Model } from "../core/types";
import { validate } from "../core/validate";
import { checkLabelExport, exportLabels } from "../io/labelExport";
import { LabelFileRefused, openLabelFile, type LabelSource } from "../io/labelFile";
import { importLabels, importTable, seedModel, type SeedMode, type SeedOutcome } from "../io/seeding";
import { openSink } from "../io/sink";
import type { RasterSource } from "../io/source";
import type { initLabels } from "./labels";
import { MESSAGES, seedMessage } from "./messages";

type Deps = {
  labels: ReturnType<typeof initLabels>;
  imagery: () => RasterSource | undefined;
  model: () => Model | undefined;
  say: (text: string) => void;
  /** Shows an error the way main's other actions do. */
  error: (e: unknown) => string;
  /** Seeding started or ended (Train is disabled meanwhile). */
  onBusy: () => void;
  /** e2e hook: sees each opened label file before it is read. */
  opened: (file: LabelSource) => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Import labels, Seed from model and Export labels (spec 004). */
// A run belongs to the imagery it started on: once another raster opens it sets no labels and no
// message (spec 003's rule for replaced rasters), and the new raster's controls are free at once.
export function initSeeding({ labels, imagery, model, say, error, onBusy, opened }: Deps) {
  const importInput = $<HTMLInputElement>("import-labels"), classMap = $<HTMLInputElement>("class-map");
  const mode = $<HTMLSelectElement>("seed-mode"), minConf = $<HTMLInputElement>("min-confidence");
  const seedBtn = $<HTMLButtonElement>("seed-model"), exportBtn = $<HTMLButtonElement>("export-labels");
  let running: RasterSource | null = null; // the imagery a seeding run started on
  let exporting = false;

  const seeding = () => running !== null && running === imagery();
  const confidence = () => { const v = minConf.valueAsNumber; return v >= 0 && v <= 1 ? v : null; };
  const modelFits = (s: RasterSource) => {
    const m = model();
    if (!m) return false;
    try { validate(m, s.meta.bandCount); return true; } catch { return false; }
  };

  /** Enables each control for the imagery, model, paint queue and runs in progress. */
  function sync(): void {
    const s = imagery(), busy = seeding(), queued = labels.busy();
    importInput.disabled = classMap.disabled = !s || busy || queued;
    seedBtn.disabled = !s || busy || queued || !modelFits(s) || confidence() === null;
    exportBtn.disabled = !s || busy || exporting;
    if (!labels.hasLabels()) mode.value = "merge"; // Merge is the default whenever labels appear
    mode.disabled = !labels.hasLabels() || busy;
  }

  /** Merge or Replace; null when the user cancels Replace's confirm. Without labels it replaces with no confirm. */
  function chosenMode(): SeedMode | null {
    if (!labels.hasLabels()) return "replace";
    if (mode.value === "merge") return "merge";
    return confirm(MESSAGES.replace) ? "replace" : null;
  }

  async function start(task: (s: RasterSource, stale: () => boolean) => Promise<SeedOutcome>): Promise<void> {
    const s = imagery()!;
    const stale = () => imagery() !== s;
    running = s;
    labels.lock(true);
    sync();
    onBusy();
    say("Seeding labels...");
    try {
      const r = await task(s, stale);
      if (stale()) return;
      if (typeof r !== "string") labels.replace(r.store, r.classes);
      say(seedMessage(r) ?? "");
    } catch (e) {
      if (!stale()) say(e instanceof LabelFileRefused ? MESSAGES.labelFile : e instanceof ClassTableError ? MESSAGES.classTable(e.field) : error(e));
    } finally {
      if (running === s) {
        running = null;
        if (!stale()) labels.lock(false); // a new raster's open() has unlocked already
      }
      sync();
      onBusy();
    }
  }

  importInput.addEventListener("change", () => {
    const tif = importInput.files?.[0], json = classMap.files?.[0];
    importInput.value = "";
    if (!tif || importInput.disabled || !imagery()) return;
    const m = chosenMode();
    if (!m) return;
    classMap.value = ""; // a class map applies to one import
    void start(async (s, stale) => {
      const text = json ? await json.text() : undefined;
      const file = await openLabelFile(tif);
      if (stale()) return "stale";
      opened(file);
      return importLabels(s, file, importTable(file, text), labels.current(), m, stale);
    });
  });

  minConf.addEventListener("input", () => {
    if (confidence() === null) say(MESSAGES.minConfidence);
    else if ($("message").textContent === MESSAGES.minConfidence) say("");
    sync();
  });

  seedBtn.addEventListener("click", () => {
    const m = model(), p = confidence();
    if (seedBtn.disabled || !m || p === null) return;
    const sm = chosenMode();
    if (!sm) return;
    void start((s, stale) => seedModel(s, m, p, labels.current(), sm, stale));
  });

  exportBtn.addEventListener("click", async () => {
    const s = imagery();
    if (!s || exportBtn.disabled) return;
    exporting = true; // one at a time: without the Save dialog, every export writes the same OPFS file
    sync();
    // the tiles and list at the click; a stroke during the write can still change a stored tile
    const store = { ...labels.store(), tiles: new Map(labels.store().tiles) };
    const list = labels.classes().map((c) => ({ ...c }));
    try {
      checkLabelExport(s, list); // before the Save dialog, so a rejected export leaves no empty file
      const sink = await openSink("labels.tif");
      say("Exporting labels...");
      try {
        await exportLabels(s, store, list, sink);
      } catch (e) {
        await sink.abort?.().catch(() => {});
        throw e;
      }
      say("Labels exported.");
    } catch (e) {
      say(error(e));
    } finally {
      exporting = false;
      sync();
    }
  });

  return { sync, seeding };
}
