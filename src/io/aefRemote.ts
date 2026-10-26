import { GeoTIFF, type GeoTIFFImage } from "geotiff";
import { openGeoTiff } from "./geotiffSource";
import { BLOCK, RangeSource, type Fetch } from "./rangeSource";
import type { RasterMeta } from "./source";

export { AefDownloadError, type Fetch } from "./rangeSource";

/** Tile grid of a COG and each tile's byte range, read from its header. */
type Layout = { tileWidth: number; tileHeight: number; tilesPerBand: number; bandSeparate: boolean; offsets: number[]; counts: number[] };

export type RemoteCog = { url: string; meta: RasterMeta; image: GeoTIFFImage; layout: Layout; source: RangeSource; releases: Map<number, number[]> };

/** Open a COG over HTTP; reads only its header, including the tile offsets. */
export async function openRemoteCog(url: string, fetchFn: Fetch, blockSize = BLOCK): Promise<RemoteCog> {
  const source = new RangeSource(url, fetchFn, blockSize);
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
 * in every band from its first read until release(cog, that window).
 */
export function planTiles(cog: RemoteCog, lastWindow: Map<number, number>): void {
  const { tilesPerBand, bandSeparate, offsets, counts } = cog.layout;
  const last = new Map<number, number>(); // offset -> last window; files may share bytes between tiles
  for (const [t, w] of lastWindow) {
    for (let b = 0; b < (bandSeparate ? cog.meta.bandCount : 1); b++) {
      const i = b * tilesPerBand + t, offset = offsets[i]!, count = counts[i]!;
      if (count === 0) continue; // sparse tile, never fetched
      cog.source.plan(offset, count);
      last.set(offset, Math.max(last.get(offset) ?? w, w));
    }
  }
  for (const [offset, w] of last) cog.releases.set(w, [...(cog.releases.get(w) ?? []), offset]);
}

/** Drop the tiles whose last reader was window w. */
export function release(cog: RemoteCog, w: number): void {
  for (const offset of cog.releases.get(w) ?? []) cog.source.release(offset);
  cog.releases.delete(w);
}

/** Raw Int8 bands of a file window [c0, r0, c1, r1], in file row order. */
export async function readInt8(cog: RemoteCog, win: [number, number, number, number]): Promise<Int8Array[]> {
  const bands = (await cog.image.readRasters({ window: win })) as unknown as ArrayLike<number>[];
  return Array.from(bands, (b) => (b instanceof Int8Array ? b : Int8Array.from(b)));
}
