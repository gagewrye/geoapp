import type { LabelClass } from "../core/classes";
import { exportName, targetAction } from "../core/exportTarget";
import type { LabelStore } from "../core/labelStore";
import { checkLabelExport, exportLabels } from "../io/labelExport";
import { maskReadFailed } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import { canPickFolder, downloadSink, existingFile, folderSink, pickFolder, sameFile, type SizedSink } from "../io/sink";
import type { RasterSource } from "../io/source";
import { MESSAGES, type MessageKind } from "./messages";

/** A user file Export must recognise (spec 055 scope 3): its handle when the app holds one, else its name and size. */
export type KnownFile = { handle: FileSystemHandle | null; name: string; size: number };

export type ExportDeps = {
  imagery: RasterSource;
  /** The labels at the click, copied: edits are locked until the export ends. */
  store: LabelStore; classes: LabelClass[]; base: MaskBase | null;
  /** Spec 050's handle: the folder picker starts in its folder. */
  startIn: FileSystemHandle | null;
  imageryFile: KnownFile | null;
  /** The imported mask's own file while it is the base, and whether the base now reads the app's copy instead (ADR 0036). */
  mask: () => (KnownFile & { copied: boolean }) | null;
  /** Resolves once the import's copy is written, or has failed (spec 055 scope 1). */
  waitCopy: () => Promise<unknown>;
  prompt: (text: string, value: string) => string | null;
  confirm: (text: string) => boolean;
  say: (text: string, kind?: MessageKind) => void;
  error: (e: unknown) => string;
  /** A verified export finished (spec 056 scope 6). */
  exported: (at: number) => void;
  now?: () => number;
};

/** Whether the target is this known file: isSameEntry with a handle, or the same name in any case and the same size. */
// Windows folders ignore case, so ORTHO.tif opens ortho.tif; isSameEntry alone may not see that, so both checks run
async function isFile(known: KnownFile | null, target: FileSystemFileHandle): Promise<boolean> {
  if (!known) return false;
  if (known.handle && await sameFile(known.handle, target)) return true;
  return target.name.toLowerCase() === known.name.toLowerCase() && (await target.getFile()).size === known.size;
}

/** The folder sink for a checked target; null when the user picks nothing, cancels, or the target is refused (said). */
async function folderTarget(d: ExportDeps, picked: Promise<FileSystemDirectoryHandle | null>): Promise<{ sink: SizedSink; name: string } | null> {
  const dir = await picked;
  if (!dir) return null; // no folder: nothing and no message
  const input = d.prompt(MESSAGES.saveAs, "labels.tif");
  if (input === null) return null;
  const name = exportName(input);
  if (!name) { d.say(MESSAGES.badName, "error"); return null; }
  await d.waitCopy(); // the mask may be about to read from the app's copy
  const existing = await existingFile(dir, name);
  const mask = d.mask();
  const action = targetAction({
    exists: existing !== null,
    imagery: existing !== null && await isFile(d.imageryFile, existing),
    mask: existing !== null && await isFile(mask, existing),
    maskCopied: mask?.copied ?? true,
  });
  if (action === "refuse-imagery") { d.say(MESSAGES.exportImagery, "error"); return null; }
  if (action === "refuse-mask") { d.say(MESSAGES.exportMask, "error"); return null; }
  if (action === "replace" && !d.confirm(MESSAGES.exportReplace(name))) return null;
  return { sink: await folderSink(dir, name), name };
}

/**
 * Export labels (specs 004, 055): on Chromium into a chosen folder through createWritable, which changes no file until
 * close (ADR 0035), else ADR 0001's download. The written size is checked; a failure aborts and overwrites nothing.
 */
export async function runExport(d: ExportDeps): Promise<void> {
  const now = d.now ?? Date.now;
  try {
    const { totalBytes } = checkLabelExport(d.imagery, d.classes); // before any picker, so a refused export writes nothing
    // the picker is called before any await: it needs the click's user activation
    const folder = canPickFolder() ? pickFolder(d.startIn ?? undefined) : null;
    const target = folder ? await folderTarget(d, folder) : { sink: await downloadSink("labels.tif"), name: null };
    if (!target) return;
    const { sink, name } = target;
    d.say("Exporting labels...");
    try {
      await exportLabels(d.imagery, d.store, d.classes, sink, d.base);
    } catch (e) {
      await sink.abort?.().catch(() => {});
      throw e;
    }
    const size = await sink.size().catch(() => -1); // the file is replaced by now: no "Nothing was overwritten"
    if (size !== totalBytes) { d.say(MESSAGES.exportShort(name ?? "labels.tif", size, totalBytes), "error"); return; }
    // a download may still be cancelled or lost, so only a file written into the folder marks the session exported
    if (name) d.exported(now());
    d.say(name ? MESSAGES.exportedTo(name, size) : "Labels exported.");
  } catch (e) {
    d.say(`${maskReadFailed(e) ? MESSAGES.maskGone : d.error(e)} ${MESSAGES.nothingOverwritten}`, "error");
  }
}
