import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { viewBox } from "../../../src/core/imagery";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { previewCells, PREVIEW_MAX_SIDE, type MaskPreview } from "../../../src/core/maskPreview";
import { LABEL_OVERLAYS, overlayKeys } from "../../../src/core/overlays";
import type { Grid } from "../../../src/core/types";
import { SETTLE_MS } from "../../../src/map/navigation";
import { initImagery } from "../../../src/ui/imagery";
import { labelDisplay, overlaysIdle } from "../../../src/ui/labelDisplay";

// Spec 048 criterion 5: at most LABEL_OVERLAYS overlays, the nearest wanted, the least recently wanted evicted,
// and the mask preview showing every other stored tile.

const PX = 1e-4, N = 24, SIDE = N * 256; // 576 tiles, EPSG:4326 at the equator
const GRID: Grid = { epsg: 4326, gt: [10, PX, 0, 1, 0, -PX], width: SIDE, height: SIDE };
const COLOURS = ["#ff0000", "#00ff00", "#0000ff"];
type Bounds = [number, number, number, number];
/** Lon/lat bounds of the raster pixel box [x0, x1) x [y0, y1). */
const bounds = (x0: number, y0: number, x1: number, y1: number): Bounds => [10 + x0 * PX, 1 - y1 * PX, 10 + x1 * PX, 1 - y0 * PX];
/** Bounds just inside tile rows r0..r1, columns 0..19. */
const rows = (r0: number, r1: number) => bounds(1, r0 * 256 + 1, 20 * 256 - 1, (r1 + 1) * 256 - 1);
const keysIn = (r0: number, r1: number) => [...store().tiles.keys()].filter((k) => { const y = Number(k.split(",")[1]) / 256; return y >= r0 && y <= r1; });

let frames: Map<number, () => void>;
let nextFrame = 1;
let peak = 0;
let store: () => LabelStore;

function fakeMap(view: { b: Bounds }) {
  const layers: string[] = [];
  const sources = new Map<string, { canvas?: { last?: { data: Uint8ClampedArray } } }>();
  const map = {
    addSource: (id: string, spec: { canvas?: never }) => { sources.set(id, spec); },
    getSource: (id: string) => (sources.has(id) ? { setWarp: () => {}, play: () => {}, pause: () => {} } : undefined),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (l: { id: string }, before?: string) => { layers.splice(before && layers.includes(before) ? layers.indexOf(before) : layers.length, 0, l.id); },
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    removeLayer: (id: string) => { layers.splice(layers.indexOf(id), 1); },
    getLayersOrder: () => [...layers],
    getStyle: () => ({ layers: layers.map((id) => ({ id })) }),
    getBounds: () => ({ getWest: () => view.b[0], getSouth: () => view.b[1], getEast: () => view.b[2], getNorth: () => view.b[3] }),
  };
  const overlaid = () => new Set(layers.filter((id) => id.startsWith("label-")).map((id) => id.slice(6)));
  return { map: map as unknown as MapLibreMap, layers, sources, overlaid };
}

/** Runs the animation frames pending now, once each (those they request wait for the next step). */
function step() {
  for (const [id, f] of [...frames]) { frames.delete(id); f(); }
}

/** Everything fake timers fake here but frames and idle callbacks, which stay on the stubs. */
const FAKED: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"] = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"];

/** fakeMap, plus what initImagery and the zoomed-in density need: events and a 1024 px wide view of view.b. */
function zoomMap(view: { b: Bounds }) {
  const m = fakeMap(view);
  const on = new Map<string, (() => void)[]>();
  const W = 1024, H = 768;
  const lng = (x: number) => view.b[0] + (x / W) * (view.b[2] - view.b[0]), lat = (y: number) => view.b[3] - (y / H) * (view.b[3] - view.b[1]);
  Object.assign(m.map, {
    on: (e: string, f: () => void) => { on.set(e, [...(on.get(e) ?? []), f]); },
    isMoving: () => false,
    getContainer: () => ({ clientWidth: W, clientHeight: H }),
    getCenter: () => ({ lng: lng(W / 2), lat: lat(H / 2) }),
    project: (p: { lng: number; lat: number }) => ({ x: ((p.lng - view.b[0]) / (view.b[2] - view.b[0])) * W, y: ((view.b[3] - p.lat) / (view.b[3] - view.b[1])) * H }),
    unproject: ([x, y]: [number, number]) => ({ lng: lng(x), lat: lat(y) }),
  });
  return { ...m, fire: (e: string) => on.get(e)?.forEach((f) => f()) };
}

/** Runs animation frames until none is pending, checking the overlay count after each. */
function runFrames(overlaid: () => Set<string>) {
  for (let i = 0; frames.size && i < 10_000; i++) {
    const [id, f] = frames.entries().next().value!;
    frames.delete(id);
    f();
    peak = Math.max(peak, overlaid().size);
  }
}

beforeEach(() => {
  frames = new Map();
  peak = 0;
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => { const id = nextFrame++; frames.set(id, f); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.stubGlobal("document", { createElement: () => {
    const c: { width: number; height: number; last?: unknown; getContext: () => unknown } = { width: 0, height: 0, getContext: () => ({ putImageData: (img: unknown) => { c.last = img; } }) };
    return c;
  } });
  vi.stubGlobal("ImageData", class { data: Uint8ClampedArray; constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** 400 stored tiles: tile columns and rows 0..19, value 1 + (column + row) % 3. */
function setup(b: Bounds) {
  const s = emptyStore(SIDE, SIDE);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) s.tiles.set(`${x * 256},${y * 256}`, new Uint8Array(65536).fill(1 + ((x + y) % 3)));
  store = () => s;
  const view = { b };
  const m = fakeMap(view);
  const display = labelDisplay(m.map, store, () => COLOURS);
  display.open(GRID);
  display.redraw(s.tiles.keys());
  runFrames(m.overlaid);
  return { ...m, view, display, s };
}

describe("capped overlays (spec 048 criterion 5)", () => {
  it("with 400 stored tiles in view, exactly the 256 nearest the centre have overlays; the preview hides exactly theirs and shows the rest", { timeout: 60_000 }, () => {
    const whole = bounds(0, 0, SIDE, SIDE);
    const t = setup(whole);
    const box = viewBox(GRID, whole)!;
    expect(box).toEqual([0, 0, SIDE, SIDE]);
    const want = overlayKeys(t.s.tiles.keys(), box, LABEL_OVERLAYS);
    expect(want).toHaveLength(256);
    expect(t.overlaid()).toEqual(new Set(want));

    const img = (t.sources.get("mask")!.canvas!.last as { data: Uint8ClampedArray });
    const { cells } = previewCells(GRID, PREVIEW_MAX_SIDE), on = new Set(want);
    let shown = 0, hidden = 0;
    for (let p = 0; p < cells.length / 2; p++) {
      const c = cells[2 * p]!, r = cells[2 * p + 1]!, a = img.data[4 * p + 3];
      if (c < 0) { expect(a).toBe(0); continue; }
      const key = `${Math.floor(c / 256) * 256},${Math.floor(r / 256) * 256}`, tile = t.s.tiles.get(key);
      if (!tile || on.has(key)) { expect(a, key).toBe(0); hidden += tile ? 1 : 0; continue; }
      const v = tile[0]!, rgb = [1, 3, 5].map((k) => parseInt(COLOURS[v - 1]!.slice(k, k + 2), 16));
      expect([...img.data.subarray(4 * p, 4 * p + 4)], key).toEqual([...rgb, 255]);
      shown++;
    }
    expect(shown).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);
  });

  it("after pans, label- tile keys never exceed 256 and the least recently wanted go first", { timeout: 60_000 }, () => {
    const t = setup(rows(0, 3));
    const pan = (b: Bounds) => { t.view.b = b; t.display.settled(); runFrames(t.overlaid); };
    const has = (keys: string[]) => keys.filter((k) => t.overlaid().has(k)).length;
    const [v1, v2, v3, v4, v5] = [keysIn(0, 3), keysIn(4, 7), keysIn(8, 11), keysIn(12, 15), keysIn(16, 19)];
    expect(has(v1)).toBe(80);
    pan(rows(4, 7));
    pan(rows(8, 11));
    expect(t.overlaid().size).toBe(240);
    pan(rows(12, 15)); // 80 more: 16 fit, 64 of the first view's go
    expect([has(v1), has(v2), has(v3), has(v4)]).toEqual([16, 80, 80, 80]);
    pan(rows(4, 7)); // wanted again: nothing to add
    expect([has(v1), has(v2), has(v3), has(v4)]).toEqual([16, 80, 80, 80]);
    pan(rows(16, 19)); // the first view's last 16, then 64 of the third view's (wanted before the fourth and the second again)
    expect([has(v1), has(v2), has(v3), has(v4), has(v5)]).toEqual([0, 80, 16, 80, 80]);
    expect(peak).toBeLessThanOrEqual(256);
    expect(t.overlaid().size).toBe(256);
  });

  it("an un-overlaid tile's preview pixels follow its edits, and an Undo's deletion puts back zeros", { timeout: 60_000 }, () => {
    const t = setup(rows(0, 0));
    const key = "0,4864"; // row 19: stored, not in view
    expect(t.overlaid().has(key)).toBe(false);
    const values = t.display.previewValues()!;
    const { cells } = previewCells(GRID, PREVIEW_MAX_SIDE);
    const pix = [...Array(cells.length / 2).keys()].filter((p) => cells[2 * p]! >= 0 && cells[2 * p]! < 256 && cells[2 * p + 1]! >= 4864 && cells[2 * p + 1]! < 5120);
    expect(pix.length).toBeGreaterThan(0);
    expect(pix.every((p) => values[p] === 1 + (19 % 3))).toBe(true);
    t.s.tiles.get(key)!.fill(3);
    t.display.redraw([key]);
    runFrames(t.overlaid);
    expect(pix.every((p) => values[p] === 3)).toBe(true);
    t.s.tiles.delete(key);
    t.display.redraw([key]);
    runFrames(t.overlaid);
    expect(pix.every((p) => values[p] === 0)).toBe(true);
  });
});

describe("idle (spec 071 criterion 5)", () => {
  const SMALL: Grid = { epsg: 4326, gt: [10, PX, 0, 1, 0, -PX], width: 512, height: 512 };
  const settledYet = async (p: Promise<void>) => { let done = false; void p.then(() => { done = true; }); await Promise.resolve(); await Promise.resolve(); return done; };

  it("resolves at once when nothing is pending", async () => {
    const m = fakeMap({ b: bounds(0, 0, 512, 512) });
    const display = labelDisplay(m.map, () => emptyStore(512, 512), () => COLOURS);
    expect(await settledYet(display.idle())).toBe(true);
    display.open(SMALL);
    expect(await settledYet(display.idle())).toBe(true);
  });

  it("resolves only once a redraw has made the stored tiles' overlays", async () => {
    const s = emptyStore(512, 512);
    const m = fakeMap({ b: bounds(0, 0, 512, 512) });
    const display = labelDisplay(m.map, () => s, () => COLOURS);
    display.open(SMALL);
    s.tiles.set("0,0", new Uint8Array(65536).fill(1));
    display.redraw(["0,0"]);
    const idle = display.idle();
    expect(await settledYet(idle)).toBe(false);
    runFrames(m.overlaid);
    expect(await settledYet(idle)).toBe(true);
    expect(m.overlaid()).toEqual(new Set(["0,0"]));
  });

  it("waits for queued quad prefetches", async () => {
    vi.useFakeTimers();
    try {
      const m = fakeMap({ b: bounds(0, 0, 512, 512) });
      const display = labelDisplay(m.map, () => emptyStore(512, 512), () => COLOURS);
      display.open(SMALL);
      display.prefetch(["0,0", "256,0"]);
      const idle = display.idle();
      runFrames(m.overlaid);
      expect(await settledYet(idle)).toBe(false);
      await vi.runAllTimersAsync(); // no requestIdleCallback here: the cache's timeouts
      runFrames(m.overlaid);
      expect(await settledYet(idle)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("overlaysIdle is safe to wait on (spec 072 criterion 1)", () => {
  const settledYet = async (p: Promise<void>) => { let done = false; void p.then(() => { done = true; }); for (let i = 0; i < 4; i++) await Promise.resolve(); return done; };
  const TILE = bounds(10 * 256 + 64, 10 * 256 + 64, 10 * 256 + 192, 10 * 256 + 192); // inside tile 2560,2560: zoomed in, one wanted key
  const preview = () => ({ values: new Uint8Array(4), width: 2, height: 2, corners: [], buckets: undefined }) as unknown as MaskPreview;

  /** A display over a mask whose tile reads wait until the test resolves them. */
  function zoomedIn() {
    const view = { b: TILE };
    const m = zoomMap(view);
    const reads = new Map<string, (t: Uint8Array | null) => void>();
    const display = labelDisplay(m.map, () => emptyStore(SIDE, SIDE), () => COLOURS,
      (key) => new Promise((resolve) => { reads.set(key, resolve); }));
    display.open(GRID);
    display.setMask(preview());
    return { ...m, display, reads };
  }

  beforeEach(() => { vi.useFakeTimers({ toFake: FAKED }); });
  afterEach(() => { vi.useRealTimers(); });

  it("idle() stays unresolved while a mask tile read is in flight, and resolves once it is read and its fill ran", async () => {
    const t = zoomedIn();
    t.display.settled();
    expect([...t.reads.keys()]).toEqual(["2560,2560"]);
    const idle = t.display.idle();
    step();
    expect(await settledYet(idle)).toBe(false);
    t.reads.get("2560,2560")!(new Uint8Array(65536).fill(2));
    await Promise.resolve(); // the read's then
    expect(await settledYet(idle)).toBe(false); // its fill is a frame away
    step();
    step();
    expect(await settledYet(idle)).toBe(true);
    expect(t.overlaid()).toEqual(new Set(["2560,2560"]));
  });

  it("the overlaysIdle hook stays unresolved while a settle is pending, and resolves after the settle and idle()", async () => {
    const t = zoomedIn();
    const imagery = initImagery(t.map, () => {}, { moving: () => false, viewSettled: () => t.display.settled() });
    t.fire("moveend");
    expect(imagery.settling()).toBe(true);
    const hook = overlaysIdle(imagery.settling, t.display.idle);
    step();
    expect(await settledYet(hook)).toBe(false); // the display alone is idle: nothing is planned for the new view yet
    expect(t.reads.size).toBe(0);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(imagery.settling()).toBe(false);
    expect([...t.reads.keys()]).toEqual(["2560,2560"]);
    step();
    expect(await settledYet(hook)).toBe(false); // settled, but its mask read is in flight
    t.reads.get("2560,2560")!(new Uint8Array(65536).fill(2));
    await Promise.resolve();
    for (let i = 0; i < 3; i++) step();
    expect(await settledYet(hook)).toBe(true);
    expect(t.overlaid()).toEqual(new Set(["2560,2560"]));
  });
});
