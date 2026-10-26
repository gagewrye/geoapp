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
  geoTags: GeoTags;
};

/** A raster readable one window at a time. */
export interface RasterSource {
  meta: RasterMeta;
  readWindow(x0: number, y0: number, width: number, height: number): Promise<Tile>;
}

/** Byte sink; a FileSystemWritableFileStream satisfies it. */
export interface Sink {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
