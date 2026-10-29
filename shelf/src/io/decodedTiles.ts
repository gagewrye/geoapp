import { getDecoder, type BaseDecoder } from "geotiff";
import type { RangeSource } from "./rangeSource";

type DecoderParameters = ConstructorParameters<typeof BaseDecoder>[0];
/** The part of a geotiff.js Pool that readRasters uses. */
export type DecoderPool = { bindParameters(compression: number, params: DecoderParameters): { decode(bytes: ArrayBuffer): Promise<ArrayBuffer> } };

/**
 * Decoded tiles of one COG. geotiff.js decodes a tile for every window read that touches it, so a
 * 1024 px tile would be decoded 16 times by 256 px windows. Planned tiles (RangeSource) are decoded
 * once and kept until released, at the same step as their bytes; other reads are decoded as usual.
 */
export class DecodedTiles {
  private readonly decoded = new Map<number, Promise<ArrayBuffer>>(); // tile offset -> decoded bytes
  private decoder: Promise<BaseDecoder> | null = null;

  constructor(private readonly source: RangeSource) {}

  /** Decoded tiles held now. */
  get size(): number { return this.decoded.size; }

  /** A decoder pool for readRasters, decoding on this thread through geotiff.js's own decoders. */
  pool(): DecoderPool {
    return {
      bindParameters: (compression, params) => ({
        decode: (bytes) => {
          // one image, so one set of decoder parameters for every tile
          const decode = async () => (await (this.decoder ??= getDecoder(compression, params))).decode(bytes) as Promise<ArrayBuffer>;
          const offset = this.source.tileOffset(bytes);
          return offset === undefined ? decode() : this.get(offset, decode);
        },
      }),
    };
  }

  /** The decoded tile at this offset, decoding it on first use. */
  get(offset: number, decode: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    let d = this.decoded.get(offset);
    if (!d) {
      const p = decode();
      p.catch(() => { if (this.decoded.get(offset) === p) this.decoded.delete(offset); });
      this.decoded.set(offset, (d = p));
    }
    return d;
  }

  release(offset: number): void { this.decoded.delete(offset); }
}
