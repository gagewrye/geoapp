import { displaySamples } from "../core/alpha";
import type { Window } from "../core/grid";
import { toRgba } from "../core/imagery";
import { samInput } from "../core/smart";
import { TILE_SIZE } from "../core/types";
import type { ImagerySource } from "./source";

/** A window's encoder tensor (spec 046 scope 4): the displayed bands in the preview's colours, read one 256 px tile at a time. */
// So the model sees what the user sees: nodata and alpha-0 pixels are black, and padding is 0.
export async function readSamInput(source: ImagerySource, w: Window, ranges: [number, number][], signal: AbortSignal): Promise<Float32Array> {
  const { bandCount, alpha, nodata } = source.meta;
  const samples = displaySamples(bandCount, alpha);
  const rgba = new Uint8ClampedArray(4 * w.width * w.height);
  for (let y = 0; y < w.height; y += TILE_SIZE) for (let x = 0; x < w.width; x += TILE_SIZE) {
    const tw = Math.min(TILE_SIZE, w.width - x), th = Math.min(TILE_SIZE, w.height - y);
    const bands = await source.readSamples(0, w.x0 + x, w.y0 + y, tw, th, samples, signal);
    signal.throwIfAborted();
    const piece = new Uint8ClampedArray(4 * tw * th);
    toRgba(bands, tw * th, ranges, nodata, piece, alpha === null ? null : bands.length - 1);
    for (let r = 0; r < th; r++) rgba.set(piece.subarray(4 * r * tw, 4 * (r + 1) * tw), 4 * ((y + r) * w.width + x));
  }
  return samInput(rgba, w.width, w.height);
}
