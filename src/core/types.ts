/** Shared core types and constants (spec 001). */

/** Web Mercator limit; MapLibre renders nothing beyond it (ADR 0004). */
export const MAX_LAT = 85.051129;
export const NODATA_OUT = 255;
export const TILE_SIZE = 256;

export type Tile = {
  x0: number;
  y0: number;
  width: number;
  height: number;
  bands: Float32Array[];
  nodata: number | null;
  /** Index into bands of the alpha sample (spec 022): a pixel whose alpha is 0 is nodata. */
  alpha?: number | null;
};

/** GDAL order: x = a + b*col + c*row, y = d + e*col + f*row. */
export type Affine = [number, number, number, number, number, number];

/** A raster's pixel grid (spec 003); spec 002's Aoi has this shape. */
export type Grid = { width: number; height: number; epsg: number; gt: Affine };
