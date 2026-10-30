import { afterEach, describe, expect, it, vi } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { buildPreview } from "../../../src/io/pipeline";
import { uint8Tiff, withOverviews } from "../helpers/tiffFixtures";

// Spec 030: the browser can hold timers ~200 ms after the preview reads while it commits a frame, so the yield before the warp isn't a timer.
const GEO = { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] as [number, number, number, number, number, number] };

afterEach(() => { vi.restoreAllMocks(); });

describe("the yield before the warp", () => {
  it("sets no timer when progress is reported", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(uint8Tiff(withOverviews(600, 400, 3, (k, c, r) => (k + c + r) % 256, []), GEO)));
    const timers: unknown[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { if (ms) timers.push(ms); return real(fn, ms); }) as typeof setTimeout);
    let calls = 0;
    const out = await buildPreview(src, 1024, { onProgress: () => { calls++; } });
    expect([out.width > 0, calls > 0, timers]).toEqual([true, true, []]);
  });
});
