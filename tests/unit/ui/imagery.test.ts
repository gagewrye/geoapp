import { describe, expect, it } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { MAX_BLOCK_BYTES } from "../../../src/core/imagery";
import type { ImagerySource } from "../../../src/io/source";
import { initImagery } from "../../../src/ui/imagery";
import { fakeSource } from "../helpers/sources";

// Spec 020 criterion 9 (unit): a block over MAX_BLOCK_BYTES turns imagery tiles off with a message.
function fakeMap() {
  const calls: string[] = [];
  const handlers: (() => void)[] = [];
  const map = {
    on: (_e: string, f: () => void) => { handlers.push(f); },
    getBounds: () => ({ getWest: () => 15, getSouth: () => 45, getEast: () => 15.01, getNorth: () => 45.01 }),
    getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
    addSource: (id: string) => { calls.push(`source ${id}`); },
    addLayer: (l: { id: string }) => { calls.push(`layer ${l.id}`); },
    getLayersOrder: () => [],
    getStyle: () => ({ layers: [] }),
  };
  return { map: map as unknown as MapLibreMap, calls, moveend: () => handlers.forEach((h) => h()) };
}

function source(bytes: number) {
  const reads: number[] = [];
  const { source: inner } = fakeSource({ width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }, () => 1);
  const s: ImagerySource = {
    ...inner, overviews: [], block: { width: 1000, height: 1000, bytes, sampleBytes: 1 },
    readSamples: (i) => { reads.push(i); return new Promise(() => {}); },
  };
  return { s, reads };
}

const RANGES: [number, number][] = [[0, 1], [0, 1], [0, 1]];

describe("full-resolution imagery on open (criterion 9)", () => {
  it("refuses a block over MAX_BLOCK_BYTES with the message, reading and adding nothing", () => {
    const { map, calls, moveend } = fakeMap();
    const imagery = initImagery(map);
    const { s, reads } = source(MAX_BLOCK_BYTES + 1);
    expect(imagery.open(s, RANGES)).toBe("Full resolution isn't available: this file stores pixels in 33 MiB blocks (limit 32 MiB). Re-save it tiled, e.g. gdal_translate -of COG.");
    moveend();
    expect(reads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("starts reading the view at the limit, and the test hook can lower it", () => {
    const { map } = fakeMap();
    const imagery = initImagery(map);
    const ok = source(MAX_BLOCK_BYTES);
    expect(imagery.open(ok.s, RANGES)).toBeNull();
    expect(ok.reads.length).toBeGreaterThan(0);
    imagery.limits.maxBlockBytes = 1000;
    const small = source(1001);
    expect(imagery.open(small.s, RANGES)).toMatch(/^Full resolution isn't available/);
    expect(small.reads).toEqual([]);
  });

  it("does nothing for a source that can't read samples", () => {
    const { map, calls } = fakeMap();
    const { source: plain } = fakeSource({ width: 100, height: 100 }, () => 1);
    expect(initImagery(map).open(plain, RANGES)).toBeNull();
    expect(calls).toEqual([]);
  });
});
