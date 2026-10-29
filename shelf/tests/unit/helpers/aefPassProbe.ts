import { fromArrayBuffer, GeoTIFFImage } from "geotiff";
import { expect, vi } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { memoryStore } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
import { RangeSource } from "../../../src/io/rangeSource";
import { aefTiff, memFetch, pattern } from "./aefTiff";

// Shared by the band-group pass, memory-bound and sparse-tile tester tests (spec 002 Cache).
export const BASE = "https://aef.test/v1/annual/";
export const OX = 500000, OY = 2800000;
export const deq = (v: number) => Math.fround((v * Math.abs(v)) / (127.5 * 127.5));

export type Spec = { name: string; gx0: number; gy0: number; width: number; height: number; tile: number; bottomUp?: boolean; interleaved?: boolean };
type Cog = { s: Spec; bytes: Uint8Array; entry: AefEntry; band: Map<number, number> };

/** Deflated synthetic COG at global pixel (gx0, gy0), with each tile offset mapped to its band. */
export async function make(s: Spec): Promise<Cog> {
  const x0 = OX + 10 * s.gx0, y1 = OY - 10 * s.gy0;
  const bytes = aefTiff({
    width: s.width, height: s.height, x0, y1, tile: s.tile, bottomUp: s.bottomUp, interleaved: s.interleaved, deflate: true,
    value: (b, r, c) => pattern(b, s.gx0 + c, s.gy0 + r),
  });
  const img = await (await fromArrayBuffer(bytes.slice().buffer)).getImage();
  const offsets = Array.from(await img.fileDirectory.loadValue("TileOffsets") as ArrayLike<number>, Number);
  const perBand = offsets.length / (s.interleaved ? 1 : AEF_BANDS);
  const band = new Map(offsets.map((o, i) => [o, s.interleaved ? -1 : Math.floor(i / perBand)]));
  const entry: AefEntry = { year: 2021, epsg: 32617, path: `2021/17N/${s.name}.tiff`, x0, y0: y1 - 10 * s.height, x1: x0 + 10 * s.width, y1 };
  return { s, bytes, entry, band };
}

/** Distinct tile columns of a COG overlapping the AOI columns [ax, ax + w) (global pixels). */
export function colsAcross(s: Spec, ax: number, w: number) {
  const a = Math.max(ax, s.gx0) - s.gx0, b = Math.min(ax + w, s.gx0 + s.width) - s.gx0;
  return b <= a ? 0 : Math.floor((b - 1) / s.tile) - Math.floor(a / s.tile) + 1;
}

/**
 * Observes every RangeSource through its public plan, fetch and release, and every readRasters
 * call: held planned tiles (fetched and not yet released) per source and their peak, planned
 * tiles fetched per read (geotiff.js decodes each one), and any planned tile fetched again after
 * its release.
 */
export function instrument() {
  type Read = { samples: number[]; window: number[]; tiles: { src: RangeSource; offset: number }[] };
  const planned = new Map<RangeSource, Map<number, number>>(), held = new Map<RangeSource, Set<number>>();
  const released = new Map<RangeSource, Set<number>>(), peak = new Map<RangeSource, number>();
  const reads: Read[] = [];
  const refetched: number[] = [];
  let current: Read | null = null;
  const { plan, fetch, release } = RangeSource.prototype;
  vi.spyOn(RangeSource.prototype, "plan").mockImplementation(function (this: RangeSource, offset: number, length: number) {
    if (!planned.has(this)) { planned.set(this, new Map()); held.set(this, new Set()); released.set(this, new Set()); }
    planned.get(this)!.set(offset, length);
    plan.call(this, offset, length);
  });
  vi.spyOn(RangeSource.prototype, "fetch").mockImplementation(function (this: RangeSource, sl: { offset: number; length: number }[], signal?: AbortSignal) {
    const h = held.get(this);
    if (h) {
      for (const x of sl) {
        if (planned.get(this)!.get(x.offset) !== x.length) continue;
        if (released.get(this)!.has(x.offset)) refetched.push(x.offset);
        h.add(x.offset);
        current?.tiles.push({ src: this, offset: x.offset });
      }
      peak.set(this, Math.max(peak.get(this) ?? 0, h.size));
    }
    return fetch.call(this, sl, signal);
  });
  vi.spyOn(RangeSource.prototype, "release").mockImplementation(function (this: RangeSource, offset: number) {
    if (held.get(this)?.delete(offset)) released.get(this)!.add(offset);
    release.call(this, offset);
  });
  const rr = GeoTIFFImage.prototype.readRasters;
  vi.spyOn(GeoTIFFImage.prototype, "readRasters").mockImplementation(async function (this: GeoTIFFImage, ...args: Parameters<typeof rr>) {
    const o = args[0] as { samples: number[]; window: number[] };
    const r: Read = { samples: o.samples, window: o.window, tiles: [] };
    // fetchEntries reads one COG window at a time, so the tiles fetched in between belong to this read
    expect(current).toBeNull();
    current = r;
    try { return await rr.apply(this, args); } finally { reads.push(r); current = null; }
  });
  return { held, peak, reads, refetched };
}

/** Each byte of each file was requested at most once (no tile fetched twice in any pass). */
export function eachByteOnce(files: Map<string, Uint8Array>, log: { url: string; range: [number, number] | null }[]) {
  for (const [url, data] of files) {
    const ranges = log.filter((l) => l.url === url).map((l) => [l.range![0], Math.min(l.range![1], data.length - 1)] as const);
    const seen = new Uint8Array(data.length);
    for (const [a, b] of ranges) seen.fill(1, a, b + 1);
    expect(ranges.reduce((t, [a, b]) => t + b - a + 1, 0), url).toBe(seen.reduce((t, v) => t + v, 0));
  }
}

export async function run(specs: Spec[], [ax, ay, w, h]: [number, number, number, number]) {
  const cogs = await Promise.all(specs.map(make));
  expect(new Set(cogs.map((c) => c.bytes.length)).size, "file sizes tell the COGs apart").toBe(cogs.length);
  const files = new Map(cogs.map((c) => [BASE + c.entry.path, c.bytes]));
  const probe = instrument();
  const { fetch, log } = memFetch(files);
  const aoi: Aoi = { epsg: 32617, gt: [OX + 10 * ax, 10, 0, OY - 10 * ay, 0, -10], width: w, height: h };
  const src = await fetchEntries(aoi, cogs.map((c) => c.entry), memoryStore(), { fetch, base: BASE });
  vi.restoreAllMocks();
  const cogOf = (s: RangeSource) => cogs.find((c) => c.bytes.length === s.fileSize)!;
  return { cogs, files, log, src, probe, cogOf, aoi };
}

/** Pixels of some bands across every window equal the pattern; NaN outside every COG. */
export async function pixelsRight(r: Awaited<ReturnType<typeof run>>, [ax, ay, w, h]: number[], step = 29) {
  for (const win of tileWindows(w!, h!)) {
    const t = await r.src.readWindow(win.x0, win.y0, win.width, win.height);
    for (const b of [0, 7, 8, 40, 63]) for (let y = 0; y < win.height; y += step) for (let x = 0; x < win.width; x += step) {
      const gx = ax! + win.x0 + x, gy = ay! + win.y0 + y;
      const inside = r.cogs.some(({ s }) => gx >= s.gx0 && gx < s.gx0 + s.width && gy >= s.gy0 && gy < s.gy0 + s.height);
      const v = t.bands[b]![y * win.width + x]!;
      if (inside) expect(v, `band ${b} at ${gx},${gy}`).toBe(deq(pattern(b, gx, gy))); else expect(v).toBeNaN();
    }
  }
}

export const groups = (k: number) => Array.from({ length: AEF_BANDS / k }, (_, g) => Array.from({ length: k }, (_, i) => g * k + i).join(","));
