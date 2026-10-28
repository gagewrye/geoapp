import type { LabelClass } from "../core/classes";
import { encodeClasses } from "../core/classTable";
import type { LabelStore } from "../core/labelStore";
import { tiffLayout, writeTiff, type TiffText } from "./tiffWriter";
import type { RasterSource, Sink } from "./source";

// 0 is unlabelled, so all of 1..255 can be classes (ADR 0013)
const text = (classes: LabelClass[]): TiffText => ({ nodata: "0", metadata: encodeClasses(classes) });

/** Throws if the label file would exceed classic TIFF (spec 001's size limit); reads and writes nothing. */
export function checkLabelExport(imagery: RasterSource, classes: LabelClass[]): void {
  const { width, height, geoTags } = imagery.meta;
  tiffLayout(width, height, geoTags, text(classes));
}

/** Streams the label GeoTIFF on the imagery's whole grid: stored tiles or zeros, and every class. Reads no imagery. */
export async function exportLabels(imagery: RasterSource, store: LabelStore, classes: LabelClass[], sink: Sink): Promise<void> {
  const { width, height, geoTags } = imagery.meta;
  await writeTiff(sink, width, height, geoTags, async (w) => store.tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height), text(classes));
}
