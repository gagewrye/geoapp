import type { LabelClass } from "../core/classes";
import { encodeClasses } from "../core/classTable";
import type { LabelStore } from "../core/labelStore";
import { effectiveTile, type MaskBase } from "./maskBase";
import { tiffLayout, writeTiff, type TiffText } from "./tiffWriter";
import type { RasterSource, Sink } from "./source";

// 0 is unlabelled, so all of 1..255 can be classes (ADR 0013)
const text = (classes: LabelClass[]): TiffText => ({ nodata: "0", metadata: encodeClasses(classes) });

/** Throws if the label file would exceed classic TIFF (spec 001's size limit); reads and writes nothing. */
export function checkLabelExport(imagery: RasterSource, classes: LabelClass[]): void {
  const { width, height, geoTags } = imagery.meta;
  tiffLayout(width, height, geoTags, text(classes));
}

/** Streams the label GeoTIFF on the imagery's whole grid: per window the stored tile, else the mask's, else zeros; and every class. */
// Only windows with no stored tile that the mask labels read the mask file (and imagery); without a mask nothing is read.
export async function exportLabels(imagery: RasterSource, store: LabelStore, classes: LabelClass[], sink: Sink, base: MaskBase | null = null): Promise<void> {
  const { width, height, geoTags } = imagery.meta;
  await writeTiff(sink, width, height, geoTags, (w) => effectiveTile(imagery, store, base, w), text(classes));
}
