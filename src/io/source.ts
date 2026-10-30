import type { Block, Overview } from "../core/imagery";
import type { Affine, Tile } from "../core/types";

/** Georeferencing tags copied unchanged from input to output (ADR 0001). */
export type GeoTags = {
  GeoKeyDirectory: number[];
  ModelPixelScale?: number[];
  ModelTiepoint?: number[];
  ModelTransformation?: number[];
  GeoDoubleParams?: number[];
  GeoAsciiParams?: string;
};

export type RasterMeta = {
  width: number;
  height: number;
  bandCount: number;
  gt: Affine;
  epsg: number;
  nodata: number | null;
  /** Floating-point samples (SampleFormat 3), which can hold NaN. */
  float: boolean;
  /** Index of the alpha sample (TIFF ExtraSamples 1 or 2, spec 022), or null. */
  alpha: number | null;
  geoTags: GeoTags;
};

/** A raster readable one window at a time. */
export interface RasterSource {
  meta: RasterMeta;
  readWindow(x0: number, y0: number, width: number, height: number): Promise<Tile>;
  // Spec 020. Optional, so a source without them (a test double) has the preview only.
  /** The full image's storage block: a tile, or a strip of width x RowsPerStrip, with all samples decoded. */
  block?: Block;
  /** Reduced-resolution IFDs with the full image's bands, by TIFF index. */
  overviews?: Overview[];
  /** Raw band arrays of a window of image 0 (full resolution) or an overview's index; rejects with AbortError on `signal`. */
  readSamples?(image: number, x0: number, y0: number, w: number, h: number, bands: number[], signal?: AbortSignal): Promise<ArrayLike<number>[]>;
}

/** A source that can draw full-resolution imagery: a GeoTIFF file. */
export type ImagerySource = RasterSource & Required<Pick<RasterSource, "block" | "overviews" | "readSamples">>;

/** Byte sink; a FileSystemWritableFileStream satisfies it. */
export interface Sink {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Discard a partial write. */
  abort?(): Promise<void>;
}
