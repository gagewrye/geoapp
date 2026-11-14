import type { LabelClass } from "../core/classes";
import { applyClassMap, type Skip } from "../core/classTable";
import { canPickFiles, pickRaster } from "../io/filePick";
import { LabelFileRefused, openLabelFile, type LabelSource } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import { importLabels, importTable } from "../io/seeding";
import type { RasterSource } from "../io/source";
import { runExport, type KnownFile } from "./exportLabels";
import type { Held, initLabels } from "./labels";
import { classMapMessage, MESSAGES, seedMessage } from "./messages";
import { initProgress } from "./progress";
import type { MessageKind } from "./messages";

type Deps = {
  labels: ReturnType<typeof initLabels>;
  imagery: () => RasterSource | undefined;
  /** The open raster's file handle, if it came through the open picker: Export's folder picker and Import labels' picker start in its folder (specs 050, 053, 055). */
  folder: () => FileSystemHandle | null;
  /** The open raster's file, which Export refuses to write over (spec 055). */
  imageryFile: () => KnownFile | null;
  say: (text: string, kind?: MessageKind) => void;
  /** Shows an error the way main's other actions do. */
  error: (e: unknown) => string;
  /** e2e hook: sees each opened label file before it is read. */
  opened: (file: LabelSource) => void;
  /** Spec 031's saved session, which an import and an export report to (specs 055, 056). */
  session: SessionHooks;
};

/**
 * What Import and Export tell the saved session: an import's mask file and base (copied, then read from the copy: ADR 0036);
 * why an import may not replace the labels (spec 056 scope 2); a flush of unsaved changes before a replace; a wait for
 * the import's copy, which resolves once written or failed (spec 055 scope 1); and a verified export's time (spec 056 scope 6).
 */
export type SessionHooks = {
  imported(file: File, base: MaskBase): void; replaceRefused(): string | null; flush(): void;
  waitCopy(): Promise<unknown>; exported(at: number): void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Import labels needs imagery, no run, no queued strokes and unlocked labels; Export labels also no export in progress (specs 004, 031). */
export function controlsDisabled(o: { imagery: boolean; seeding: boolean; queued: boolean; exporting: boolean; locked: boolean }) {
  const importLabels = !o.imagery || o.seeding || o.queued || o.locked;
  return { importLabels, exportLabels: importLabels || o.exporting };
}

/** Import labels and Export labels (spec 004), with the import's progress and Cancel (spec 021), and Apply class map (spec 047). */
// A run belongs to the imagery it started on: once another raster opens it sets no labels and no
// message (spec 003's rule for replaced rasters), and the new raster's controls are free at once.
export function initSeeding({ labels, imagery, folder, imageryFile, say, error, opened, session }: Deps) {
  const importInput = $<HTMLInputElement>("import-labels"), classMap = $<HTMLInputElement>("class-map");
  const exportBtn = $<HTMLButtonElement>("export-labels"), cancelBtn = $<HTMLButtonElement>("import-cancel");
  // its own bar, so an open and an import don't hide each other's (spec 021)
  const progress = initProgress($<HTMLProgressElement>("import-progress"));
  let running: RasterSource | null = null; // the imagery a seeding run started on
  let cancelled = false; // the running import's Cancel was pressed
  let exporting: RasterSource | null = null; // the imagery an export started on
  // the last import's own file (its handle when spec 053's picker gave one), and the base and LabelSource it made:
  // Export refuses to write over it until the base reads the app's copy instead (spec 055 scope 3, ADR 0036)
  let mask: { known: KnownFile; base: MaskBase; source: LabelSource } | null = null;

  const seeding = () => running !== null && running === imagery();
  // Seeding and exporting each lock the brush and class edits; the lock lifts once neither runs on this imagery.
  const relock = () => labels.lock(seeding() || (exporting !== null && exporting === imagery()));

  /** Shows the import's bar (indeterminate until a window is done) and Cancel, or hides both. */
  const showRun = (on: boolean) => { progress.hide(); cancelBtn.hidden = !on; if (on) progress.busy(); };

  /** Enables each control for the imagery, paint queue and runs in progress; hides a replaced raster's import bar at once. */
  function sync(): void {
    const s = imagery(), busy = seeding(), queued = labels.busy();
    if (running && !busy) showRun(false); // its run may still be waiting on a read (spec 021 criterion 7)
    const off = controlsDisabled({ imagery: !!s, seeding: busy, queued, exporting: exporting !== null, locked: labels.restoring() });
    importInput.disabled = off.importLabels;
    // spec 047: only with an imported mask, under none of spec 004's locks (a run or a restore offer)
    classMap.disabled = !labels.base() || busy || exporting !== null || labels.restoring();
    exportBtn.disabled = off.exportLabels;
  }

  /** Every import replaces (spec 017): true unless labels exist and the user cancels the confirm. */
  const replaceConfirmed = () => !labels.hasLabels() || confirm(MESSAGES.replace);

  // Order (spec 021): header checks, then the old labels leave the map (held, not
  // dropped), then the passes. Only success replaces; a failure, Cancel, "empty" or "too many" restores
  // the held labels with their history. Locks stop any edit to the held state meanwhile.
  async function runImport(s: RasterSource, tif: File, handle: FileSystemHandle | null): Promise<void> {
    cancelled = false;
    const stale = () => imagery() !== s || cancelled;
    running = s;
    relock();
    sync();
    say(MESSAGES.importing);
    let held: Held | null = null;
    try {
      const file = await openLabelFile(tif);
      if (stale()) return;
      opened(file);
      const { table, skipped } = importTable(file); // a bad table never refuses (spec 047)
      held = labels.hold();
      showRun(true);
      const r = await importLabels(s, file, table, stale, (done, total) => { if (!stale()) progress.step(done, total); }, labels.masks() ?? undefined);
      if (imagery() !== s) return;
      if (cancelled) { labels.restore(held); say(MESSAGES.importCancelled); return; }
      if (typeof r === "string") labels.restore(held);
      else {
        labels.replace(r.store, r.classes, r.base);
        mask = r.base && { known: { handle, name: tif.name, size: tif.size }, base: r.base, source: r.base.file };
        if (r.base) session.imported(tif, r.base);
      }
      say(seedMessage(r, skipped) ?? "", r === "too many" ? "error" : "info");
    } catch (e) {
      if (imagery() !== s) return;
      if (held) labels.restore(held);
      if (cancelled) { say(MESSAGES.importCancelled); return; } // a read in flight at Cancel may still reject
      say(e instanceof LabelFileRefused ? MESSAGES.labelFile : error(e), "error");
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

  /** A chosen label file, from the input or the picker: the checks, spec 017's confirm, then the import. */
  function chosen(tif: File | undefined, handle: FileSystemHandle | null = null): void {
    const s = imagery();
    if (!tif || importInput.disabled || !s) return;
    const refused = labels.hasLabels() ? session.replaceRefused() : null;
    if (refused) { say(refused, "error"); return; }
    if (!replaceConfirmed()) return;
    session.flush(); // before the run: the old labels' last changes are saved as theirs (spec 056)
    void runImport(s, tif, handle);
  }

  importInput.addEventListener("change", () => {
    const tif = importInput.files?.[0];
    importInput.value = "";
    chosen(tif);
  });
  // Spec 053: with the imagery's handle on Chromium, the picker replaces the input's chooser so it opens in the imagery's folder
  importInput.addEventListener("click", (e) => {
    const start = folder();
    if (!canPickFiles() || !start) return;
    e.preventDefault();
    const picked = pickRaster(start); // within the click: the picker needs its user activation, so nothing is awaited first
    void (async () => {
      let tif: File, handle: FileSystemFileHandle | null;
      try {
        handle = await picked;
        if (!handle) return; // cancelled: nothing and no message
        tif = await handle.getFile();
      } catch (err) {
        say(error(err), "error"); // as a failed import read is said
        return;
      }
      chosen(tif, handle);
    })();
  });

  // Renames and recolours by the mask's raw values (base.lut); painted tiles, the mask and history stay
  classMap.addEventListener("change", async () => {
    const f = classMap.files?.[0], base = labels.base();
    classMap.value = ""; // the same file may be applied again
    if (!f || classMap.disabled || !base) return;
    let text: string;
    try {
      text = await f.text();
    } catch (e) {
      say(error(e), "error"); // as Import labels says a failed read (spec 019)
      return;
    }
    if (labels.base() !== base || classMap.disabled) return; // an import, export or restore began meanwhile
    let r: { classes: LabelClass[]; applied: number; skipped: Skip[] };
    try {
      r = applyClassMap(labels.classes(), base.lut, JSON.parse(text));
    } catch {
      r = { classes: [], applied: 0, skipped: [{ field: "JSON", why: "is not valid JSON" }] };
    }
    if (r.applied) labels.setClasses(r.classes);
    const m = classMapMessage(r.applied, r.skipped);
    say(m.text, m.kind);
  });

  /** The imported mask's own file while it is the base; copied once the base reads the app's copy (ADR 0036). */
  const maskFile = () => {
    const b = labels.base();
    return mask && b === mask.base ? { ...mask.known, copied: b.file !== mask.source } : null;
  };

  exportBtn.addEventListener("click", async () => {
    const s = imagery();
    if (!s || exportBtn.disabled || labels.busy()) return;
    exporting = s; // one at a time: without folder access, every export writes the same OPFS file
    // no queued cells (Export waits for them) and no strokes or class edits until it ends, so no
    // stored tile changes in place and the file holds exactly the labels and classes at the click
    relock();
    sync();
    try {
      // runExport calls the folder picker before its first await, within this click's user activation
      await runExport({
        imagery: s, store: { ...labels.store(), tiles: new Map(labels.store().tiles) }, classes: labels.classes().map((c) => ({ ...c })),
        base: labels.base(), // read only: it changes only on an import or a raster open
        startIn: folder(), imageryFile: imageryFile(), mask: maskFile, waitCopy: () => session.waitCopy(),
        prompt: (t, v) => prompt(t, v), confirm: (t) => confirm(t), say, error, exported: (at) => session.exported(at),
      });
    } finally {
      exporting = null;
      relock();
      sync();
    }
  });

  return { sync, seeding };
}
