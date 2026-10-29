/** North-up reads of bottom-up rasters (positive y scale), whose first file row is the southernmost. */

/** File rows [start, end) holding north-up rows [y0, y0 + h) of a bottom-up file of `height` rows. */
export function fileRows(height: number, y0: number, h: number): [number, number] {
  return [height - y0 - h, height - y0];
}

/** A copy of a row-major band with its rows in reverse order. */
export function flipRows(band: Float32Array, width: number, height: number): Float32Array {
  if (band.length !== width * height) throw new Error(`flipRows: ${band.length} values for ${width} x ${height}`);
  const out = new Float32Array(band.length);
  for (let r = 0; r < height; r++) out.set(band.subarray(r * width, (r + 1) * width), (height - 1 - r) * width);
  return out;
}
