// Fragment of src/io/geotiffSource.ts (spec 013): AlphaEarth detection and dequantizing, to merge back by hand.
// openGeoTiff and openFile returned a GeoTiffSource; openGeoTiff set `aef` and `nodata` and read bands like this:
//   // AlphaEarth COGs are read dequantized (spec 002); their no data becomes NaN.
//   const aef = isAef(fd.getValue("SampleFormat"), fd.getValue("BitsPerSample"), bandCount, nd);
//   const nodata = aef || nd === null ? null : Math.fround(nd);
//   return { aef, meta: ..., async readWindow(x0, y0, w, h) { ...
//     const bands = Array.from(rasters, (r) => {
//       if (!aef) return r instanceof Float32Array ? r : Float32Array.from(r);
//       const out = new Float32Array(r.length);
//       dequantize(r as Int8Array, out);
//       return out;
//     }); ... } };
import { AEF_BANDS, AEF_NODATA_Q, dequantize } from "../core/aef";
import type { RasterSource } from "./source";

/** A raster from a GeoTIFF; `aef` is true for an AlphaEarth-encoded file, read dequantized. */
export type GeoTiffSource = RasterSource & { aef: boolean };

/** 64 signed 8-bit bands with GDAL_NODATA -128: the AlphaEarth Int8 encoding. */
function isAef(format: unknown, bits: unknown, bandCount: number, nodata: number | null): boolean {
  // a missing SampleFormat means unsigned; a single value may come back as a number
  const all = (v: unknown, x: number) => v !== undefined && Array.from(typeof v === "number" ? [v] : (v as ArrayLike<number>)).every((e) => e === x);
  return bandCount === AEF_BANDS && nodata === AEF_NODATA_Q && all(format, 2) && all(bits, 8);
}
