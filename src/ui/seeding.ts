import { ClassTableError } from "../core/classTable";
import { checkLabelExport, exportLabels } from "../io/labelExport";
import { LabelFileRefused, maskReadFailed, openLabelFile, type LabelSource } from "../io/labelFile";
import { importLabels, importTable } from "../io/seeding";
import { openSink } from "../io/sink";
import type { RasterSource } from "../io/source";
import type { Held, initLabels } from "./labels";
import { MESSAGES, seedMessage } from "./messages";
import { initProgress } from "./progress";

type Deps = {
  labels: ReturnType<typeof initLabels>;
  imagery: () => RasterSource | undefined;
  say: (text: string) => void;
  /** Shows an error the way main's other actions do. */
  error: (e: unknown) => string;
  /** e2e hook: sees each opened label file before it is read. */
  opened: (file: LabelSource) => void;
  /** An import replaced the labels with this file's mask: spec 031 copies it. */
  imported?: (file: File) => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Import labels and Export labels (spec 004), with the import's progress and Cancel (spec 021). */
// A run belongs to the imagery it started on: once another raster opens it sets no labels and no
// message (spec 003's rule for replaced rasters), and the new raster's controls are free at once.
export function initSeeding({ labels, imagery, say, error, opened, imported }: Deps) {
  const importInput = $<HTMLInputElement>("import-labels"), classMap = $<HTMLInputElement>("class-map");
  const exportBtn = $<HTMLButtonElement>("export-labels"), cancelBtn = $<HTMLButtonElement>("import-cancel");
  // its own bar, so an open and an import don't hide each other's (spec 021)
  const progress = initProgress($<HTMLProgressElement>("import-progress"));
  let running: RasterSource | null = null; // the imagery a seeding run started on
  let cancelled = false; // the running import's Cancel was pressed
  let exporting: RasterSource | null = null; // the imagery an export started on

  const seeding = () => running !== null && running === imagery();
  // Seeding and exporting each lock the brush and class edits; the lock lifts once neither runs on this imagery.
  const relock = () => labels.lock(seeding() || (exporting !== null && exporting === imagery()));

  /** Shows the import's bar (indeterminate until a window is done) and Cancel, or hides both. */
  const showRun = (on: boolean) => { progress.hide(); cancelBtn.hidden = !on; if (on) progress.busy(); };

  /** Enables each control for the imagery, paint queue and runs in progress; hides a replaced raster's import bar at once. */
  function sync(): void {
    const s = imagery(), busy = seeding(), queued = labels.busy();
    if (running && !busy) showRun(false); // its run may still be waiting on a read (spec 021 criterion 7)
    importInput.disabled = classMap.disabled = !s || busy || queued;
    exportBtn.disabled = !s || busy || queued || exporting !== null;
  }

  /** Every import replaces (spec 017): true unless labels exist and the user cancels the confirm. */
  const replaceConfirmed = () => !labels.hasLabels() || confirm(MESSAGES.replace);

  // Order (spec 021): header and class-table checks, then the old labels leave the map (held, not
  // dropped), then the passes. Only success replaces; a failure, Cancel, "empty" or "too many" restores
  // the held labels with their history. Locks stop any edit to the held state meanwhile.
  async function runImport(s: RasterSource, tif: File, json: File | undefined): Promise<void> {
    cancelled = false;
    const stale = () => imagery() !== s || cancelled;
    running = s;
    relock();
    sync();
    say(MESSAGES.importing);
    let held: Held | null = null;
    try {
      const text = json ? await json.text() : undefined;
      const file = await openLabelFile(tif);
      if (stale()) return;
      opened(file);
      const table = importTable(file, text);
      held = labels.hold();
      showRun(true);
      const r = await importLabels(s, file, table, stale, (done, total) => { if (!stale()) progress.step(done, total); }, labels.masks() ?? undefined);
      if (imagery() !== s) return;
      if (cancelled) { labels.restore(held); say(MESSAGES.importCancelled); return; }
      if (typeof r === "string") labels.restore(held);
      else { labels.replace(r.store, r.classes, r.base); imported?.(tif); }
      say(seedMessage(r) ?? "");
    } catch (e) {
      if (imagery() !== s) return;
      if (held) labels.restore(held);
      if (cancelled) { say(MESSAGES.importCancelled); return; } // a read in flight at Cancel may still reject
      say(e instanceof LabelFileRefused ? MESSAGES.labelFile : e instanceof ClassTableError ? MESSAGES.classTable(e.field) : error(e));
    } finally {
      if (running === s) {
        running = null;
        showRun(false);
        relock(); // a new raster's open() has unlocked already
      }
      sync();
    }
  }

  cancelBtn.addEventListener("click", () => { if (seeding()) cancelled = true; });

  importInput.addEventListener("change", () => {
    const tif = importInput.files?.[0], json = classMap.files?.[0];
    importInput.value = "";
    const s = imagery();
    if (!tif || importInput.disabled || !s) return;
    if (!replaceConfirmed()) return;
    classMap.value = ""; // a class map applies to one import
    void runImport(s, tif, json);
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
