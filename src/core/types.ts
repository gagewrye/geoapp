/** Shared core types and constants (spec 001). */
export const EPS = 1e-6;
/** Web Mercator limit; MapLibre renders nothing beyond it (ADR 0004). */
export const MAX_LAT = 85.051129;
export const NODATA_OUT = 255;
export const TILE_SIZE = 256;

export type Model = {
  version: 1;
  type: "logreg";
  bands: number[];
  mean: number[];
  std: number[];
  classes: string[];
  W: number[][];
  b: number[];
};

export type Tile = {
  x0: number;
  y0: number;
  width: number;
  height: number;
  bands: Float32Array[];
  nodata: number | null;
};

/** GDAL order: x = a + b*col + c*row, y = d + e*col + f*row. */
export type Affine = [number, number, number, number, number, number];

export type PixelPolygon = { rings: [number, number][][]; label: number };
