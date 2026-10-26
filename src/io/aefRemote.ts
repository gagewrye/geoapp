import { GeoTIFF, type GeoTIFFImage } from "geotiff";
import { openGeoTiff } from "./geotiffSource";
import { BLOCK, RangeSource, type Fetch } from "./rangeSource";
import type { RasterMeta } from "./source";

export { AefDownloadError, type Fetch } from "./rangeGet";

/** Tile grid of a COG and each tile's byte range, read from its header. */
type Layout = { tileWidth: number; tileHeight: number; tilesPerBand: number; bandSeparate: boolean; offsets: number[]; counts: number[] };

export type RemoteCog = { url: string; meta: RasterMeta; image: GeoTIFFImage; layout: Layout; source: RangeSource; releases: Map<number, number[]> };

/** Open a COG over HTTP; reads only its header, including the tile offsets. */
export async function openRemoteCog(url: string, fetchFn: Fetch, opts: { blockSize?: number; timeoutMs?: number } = {}): Promise<RemoteCog> {
  const source = new RangeSource(url, fetchFn, opts.blockSize ?? BLOCK, opts.timeoutMs);
  const tiff = await GeoTIFF.fromSource(source as unknown as Parameters<typeof GeoTIFF.fromSource>[0]);
  const { meta } = await openGeoTiff(tiff);
  const image = await tiff.getImage(0);
  // loaded now, through header blocks, so later reads are only tiles
  const [offsets, counts] = await Promise.all((image.isTiled ? ["TileOffsets", "TileByteCounts"] as const : ["StripOffsets", "StripByteCounts"] as const)
    .map(async (tag) => Array.from(await image.fileDirectory.loadValue(tag) as ArrayLike<number | bigint>, Number)));
  const tileWidth = image.getTileWidth(), tileHeight = image.getTileHeight();
  const tilesPerBand = Math.ceil(image.getWidth() / tileWidth) * Math.ceil(image.getHeight() / tileHeight);
  const layout = { tileWidth, tileHeight, tilesPerBand, bandSeparate: image.planarConfiguration === 2, offsets: offsets!, counts: counts! };
  return { url, meta, image, layout, source, releases: new Map() };
}

/**
 * Keep each listed tile (in-band index -> last AOI window reading it, from core tileLastWindow)
 * from its first read until release(cog, its last step). Downloads run in passes of `group`
 * bands over `windows` windows, so band b's tile is last read at step floor(b / group) * windows + w.
 */
export function planTiles(cog: RemoteCog, lastWindow: Map<number, number>, windows: number, group: number): void {
  const { tilesPerBand, bandSeparate, offsets, counts } = cog.layout;
  const last = new Map<number, number>(); // offset -> last step; files may share bytes between tiles
  for (const [t, w] of lastWindow) {
    // a pixel-interleaved tile holds every band, so it is read in pass 0 only (group = 64)
    for (let b = 0; b < (bandSeparate ? cog.meta.bandCount : 1); b++) {
      const i = b * tilesPerBand + t, offset = offsets[i]!, count = counts[i]!;
      if (count === 0) continue; // sparse tile, never fetched
      cog.source.plan(offset, count);
      const step = Math.floor(b / group) * windows + w;
      last.set(offset, Math.max(last.get(offset) ?? step, step));
    }
  }
  for (const [offset, step] of last) cog.releases.set(step, [...(cog.releases.get(step) ?? []), offset]);
}

/** Drop the tiles whose last reader was this step. */
export function release(cog: RemoteCog, step: number): void {
  for (const offset of cog.releases.get(step) ?? []) cog.source.release(offset);
  cog.releases.delete(step);
}

/** Raw Int8 bands [b0, b1) of a file window [c0, r0, c1, r1], in file row order. */
export async function readInt8(cog: RemoteCog, win: [number, number, number, number], [b0, b1]: [number, number]): Promise<Int8Array[]> {
  const samples = Array.from({ length: b1 - b0 }, (_, k) => b0 + k);
  const bands = (await cog.image.readRasters({ window: win, samples })) as unknown as ArrayLike<number>[];
  return Array.from(bands, (b) => (b instanceof Int8Array ? b : Int8Array.from(b)));
}
