import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { opfsStore, type CacheStore } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { memFetch, type Override } from "../helpers/aefTiff";
import { aoi, bandTiles, BASE, COGS, east, files, MSG, trackWritables } from "../helpers/aefCacheFixture";
import { fakeOpfs } from "../helpers/fakeOpfs";

// Tester re-verification of failures with the per-band cache (spec 002 criterion 12): on any
// failure in any pass, every open writer is aborted and the cache is gone.
afterEach(() => vi.restoreAllMocks());

describe("failure in any pass (tester, criterion 12 with the per-band cache)", () => {
  /** Run with a fake OPFS; returns the outcome, the writables, and whether the cache folder is gone. */
  async function failing(opts: { fault?: Override; wrap?: (s: CacheStore) => CacheStore }) {
    const tw = trackWritables();
    const { handle, locks, root } = fakeOpfs();
    const raw = await opfsStore("aef-cache", handle, { locks });
    const store = opts.wrap ? opts.wrap(raw) : raw;
    const { fetch, log } = memFetch(files, opts.fault);
    const err = await fetchEntries(aoi, COGS.map((c) => c.entry), store, { fetch, base: BASE }).then(() => null, (e: unknown) => e);
    return { err, ws: tw.ws, gone: !root.entries.has("aef-cache"), log, raw };
  }
  const noneOpen = (ws: { state: string }[]) => expect(ws.filter((w) => w.state === "open")).toEqual([]);

  it.each(Array.from({ length: AEF_BANDS / BAND_GROUP }, (_, p) => p))("a network failure on the east COG's band tiles of pass %d: message, every open writer aborted, cache deleted, later passes never started", async (p) => {
    const bad = await bandTiles(east, p * BAND_GROUP + 3);
    const r = await failing({ fault: (url, range) => (url.endsWith("east.tiff") && range && bad.has(range[0]) ? "network" : undefined) });
    expect(r.err).toBeInstanceOf(Error);
    expect((r.err as Error).message).toBe(MSG);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws).toHaveLength((p + 1) * BAND_GROUP); // no writer for a later pass
    expect(r.ws.slice(p * BAND_GROUP).every((w) => w.state === "aborted")).toBe(true);
    expect(r.ws.slice(0, p * BAND_GROUP).every((w) => w.state === "closed")).toBe(true);
    await expect(r.raw.read(0)).rejects.toThrow();
  });

  it("the very last append (band 63, last window) fails: the cause surfaces, the 8 open writers are aborted, cache deleted", async () => {
    const n = tileWindows(aoi.width, aoi.height).length;
    const boom = new Error("disk full");
    const r = await failing({
      wrap: (s) => ({
        ...s,
        async band(b) {
          const w = await s.band(b);
          let i = 0;
          return { ...w, append: async (pl) => { if (b === 63 && i++ === n - 1) throw boom; return w.append(pl); } };
        },
      }),
    });
    expect(r.err).toBe(boom);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws).toHaveLength(AEF_BANDS);
    expect(r.ws.slice(56).every((w) => w.state === "aborted")).toBe(true);
  });

  it("closing band 60 in the last pass fails: bands 61..63 and band 60 are aborted, nothing left open, cache deleted", async () => {
    const boom = new Error("close failed");
    const r = await failing({
      wrap: (s) => ({
        ...s,
        async band(b) {
          const w = await s.band(b);
          return { ...w, close: async () => { if (b === 60) throw boom; return w.close(); } };
        },
      }),
    });
    expect(r.err).toBe(boom);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws.slice(60).map((w) => w.state)).toEqual(["aborted", "aborted", "aborted", "aborted"]);
  });

  it("opening band 27's file fails mid-group: bands 24..26 are aborted, the cause surfaces, cache deleted", async () => {
    const boom = new Error("quota");
    const r = await failing({ wrap: (s) => ({ ...s, band: async (b) => { if (b === 27) throw boom; return s.band(b); } }) });
    expect(r.err).toBe(boom);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws.map((w) => w.state)).toEqual([...Array(24).fill("closed"), "aborted", "aborted", "aborted"]);
  });

  it("an abort that rejects and a discard that rejects do not hide the download error", async () => {
    const r = await failing({
      fault: (url, range) => (url.endsWith("east.tiff") && range && range[0] > 20000 ? "network" : undefined),
      wrap: (s) => ({
        ...s,
        async band(b) { const w = await s.band(b); return { ...w, abort: async () => { await w.abort(); throw new Error("abort failed"); } }; },
        async discard() { throw new Error("discard failed"); },
      }),
    });
    expect((r.err as Error).message).toBe(MSG);
    noneOpen(r.ws);
  });
});
