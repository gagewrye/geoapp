import { ClassTableError } from "../core/classTable";
import { checkLabelExport, exportLabels } from "../io/labelExport";
import { LabelFileRefused, maskReadFailed, openLabelFile, type LabelSource } from "../io/labelFile";
import { importLabels, importTable, type SeedOutcome } from "../io/seeding";
import { openSink } from "../io/sink";
import type { RasterSource } from "../io/source";
import type { initLabels } from "./labels";
import { MESSAGES, seedMessage } from "./messages";

type Deps = {
  labels: ReturnType<typeof initLabels>;
  imagery: () => RasterSource | undefined;
  say: (text: string) => void;
  /** Shows an error the way main's other actions do. */
  error: (e: unknown) => string;
  /** e2e hook: sees each opened label file before it is read. */
  opened: (file: LabelSource) => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Import labels and Export labels (spec 004). */
// A run belongs to the imagery it started on: once another raster opens it sets no labels and no
// message (spec 003's rule for replaced rasters), and the new raster's controls are free at once.
export function initSeeding({ labels, imagery, say, error, opened }: Deps) {
  const importInput = $<HTMLInputElement>("import-labels"), classMap = $<HTMLInputElement>("class-map");
  const exportBtn = $<HTMLButtonElement>("export-labels");
  let running: RasterSource | null = null; // the imagery a seeding run started on
  let exporting: RasterSource | null = null; // the imagery an export started on

  const seeding = () => running !== null && running === imagery();
  // Seeding and exporting each lock the brush and class edits; the lock lifts once neither runs on this imagery.
  const relock = () => labels.lock(seeding() || (exporting !== null && exporting === imagery()));

  /** Enables each control for the imagery, paint queue and runs in progress. */
  function sync(): void {
    const s = imagery(), busy = seeding(), queued = labels.busy();
    importInput.disabled = classMap.disabled = !s || busy || queued;
    exportBtn.disabled = !s || busy || queued || exporting !== null;
  }

  /** Every import replaces (spec 017): true unless labels exist and the user cancels the confirm. */
  const replaceConfirmed = () => !labels.hasLabels() || confirm(MESSAGES.replace);

  async function start(task: (s: RasterSource, stale: () => boolean) => Promise<SeedOutcome>): Promise<void> {
    const s = imagery()!;
    const stale = () => imagery() !== s;
    running = s;
    relock();
    sync();
    say("Seeding labels...");
    try {
      const r = await task(s, stale);
      if (stale()) return;
      if (typeof r !== "string") labels.replace(r.store, r.classes, r.base);
      say(seedMessage(r) ?? "");
    } catch (e) {
      if (!stale()) say(e instanceof LabelFileRefused ? MESSAGES.labelFile : e instanceof ClassTableError ? MESSAGES.classTable(e.field) : error(e));
    } finally {
      if (running === s) {
        running = null;
        relock(); // a new raster's open() has unlocked already
      }
      sync();
    }
  }

  importInput.addEventListener("change", () => {
    const tif = importInput.files?.[0], json = classMap.files?.[0];
    importInput.value = "";
    if (!tif || importInput.disabled || !imagery()) return;
    if (!replaceConfirmed()) return;
    classMap.value = ""; // a class map applies to one import
    void start(async (s, stale) => {
      const text = json ? await json.text() : undefined;
      const file = await openLabelFile(tif);
      if (stale()) return "stale";
      opened(file);
      return importLabels(s, file, importTable(file, text), stale);
    });
  });

  exportBtn.addEventListener("click", async () => {
    const s = imagery();
    if (!s || exportBtn.disabled || labels.busy()) return;
    exporting = s; // one at a time: without the Save dialog, every export writes the same OPFS file
    // no queued cells (Export waits for them) and no strokes or class edits until it ends, so no
    // stored tile changes in place and the file holds exactly the labels and classes at the click
    relock();
    sync();
    const store = { ...labels.store(), tiles: new Map(labels.store().tiles) };
    const list = labels.classes().map((c) => ({ ...c }));
    const base = labels.base(); // read only: it changes only on an import or a raster open
    try {
      checkLabelExport(s, list); // before the Save dialog, so a rejected export leaves no empty file
      const sink = await openSink("labels.tif");
      say("Exporting labels...");
      try {
        await exportLabels(s, store, list, sink, base);
      } catch (e) {
        await sink.abort?.().catch(() => {});
        throw e;
      }
      say("Labels exported.");
    } catch (e) {
      say(maskReadFailed(e) ? MESSAGES.maskGone : error(e));
    } finally {
      exporting = null;
      relock();
      sync();
    }
  });

  return { sync, seeding };
}
