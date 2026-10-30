import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { ImagerySource } from "../../../src/io/source";
import { MaskCache, HOVER, STROKE } from "../../../src/io/maskCache";
import { createNavigation, SETTLE_MS } from "../../../src/map/navigation";
import { initImagery } from "../../../src/ui/imagery";
import { fakeSource, samplesSource } from "../helpers/sources";

// Spec 027, tester edge cases: several keys, modifiers and blur ending a hold, stray key-ups, a wheel burst
// meeting a key press, and background mask reads wired to imagery.moving() under fake timers.
type Handler = (e: { code?: string; key?: string; preventDefault?: () => void }) => void;
const listeners = new Map<string, Handler[]>();
const on = (type: string, f: Handler) => { listeners.set(type, [...(listeners.get(type) ?? []), f]); };
const fire = (type: string, e: Parameters<Handler>[0] = {}) => listeners.get(type)?.forEach((f) => f({ preventDefault() {}, ...e }));
const down = (code: string) => fire("keydown", { code, key: code.slice(3).toLowerCase() });
const up = (code: string) => fire("keyup", { code, key: code.slice(3).toLowerCase() });

function fakeMap() {
  const events = new Map<string, (() => void)[]>();
  let bounds = 0;
  const node = { addEventListener() {}, contains: () => false, classList: { add() {}, remove() {} } };
  const emit = (e: string) => events.get(e)?.forEach((f) => f());
  const map = {
    on: (e: string, f: () => void) => { events.set(e, [...(events.get(e) ?? []), f]); },
    getBounds: () => { bounds++; return { getWest: () => 15, getSouth: () => 45, getEast: () => 15.01, getNorth: () => 45.01 }; },
    getContainer: () => ({ ...node, clientWidth: 800, clientHeight: 600 }),
    getCanvasContainer: () => node,
    getCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    panBy: () => { emit("move"); emit("moveend"); },
    isMoving: () => false,
    addSource() {}, addLayer() {}, getLayersOrder: () => [], getStyle: () => ({ layers: [] }),
  };
  return { map: map as unknown as MapLibreMap, emit, updates: () => bounds };
}

const source = (): ImagerySource => {
  const { source: inner } = fakeSource({ width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }, () => 1);
  return { ...inner, overviews: [], block: { width: 256, height: 256, bytes: 256 * 256 * 12 }, readSamples: () => new Promise(() => {}) };
};

function setup() {
  const { map, emit, updates } = fakeMap();
  let nav: ReturnType<typeof createNavigation> | null = null;
  const imagery = initImagery(map, () => {}, { moving: () => nav?.moving() ?? false });
  nav = createNavigation(map, { typing: () => false, stroking: () => false });
  const settled = vi.fn();
  nav.onSettle(imagery.settle);
  const off = nav.onSettle(settled);
  imagery.open(source(), [[0, 1], [0, 1], [0, 1]]);
  return { nav, imagery, emit, updates, settled, off };
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  vi.stubGlobal("window", { addEventListener: on });
  vi.stubGlobal("document", { addEventListener: on, activeElement: null, visibilityState: "visible" });
  vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("settle edge cases (criterion 1)", () => {
  it("with two keys held, releasing one keeps the pan going; one update 150 ms after the last is up", () => {
    const { nav, updates, settled } = setup();
    const before = updates();
    down("KeyD"); down("KeyW");
    vi.advanceTimersByTime(400);
    up("KeyD");
    expect(nav.moving()).toBe(true);
    vi.advanceTimersByTime(400);
    expect(settled).not.toHaveBeenCalled();
    expect(updates()).toBe(before);
    up("KeyW");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(updates()).toBe(before + 1);
    vi.advanceTimersByTime(1000);
    expect(updates()).toBe(before + 1);
  });

  it.each([["a modifier key", () => fire("keydown", { key: "Shift", code: "ShiftLeft" })], ["blur", () => fire("blur")],
    ["the tab hidden", () => { (document as { visibilityState: string }).visibilityState = "hidden"; fire("visibilitychange"); }]])(
    "%s ending a hold settles once and updates once", (_n, end) => {
      const { nav, updates, settled } = setup();
      const before = updates();
      down("KeyA");
      vi.advanceTimersByTime(300);
      end();
      expect(nav.moving()).toBe(false);
      vi.advanceTimersByTime(SETTLE_MS);
      expect(settled).toHaveBeenCalledTimes(1);
      up("KeyA"); // the key-up after a stop: nothing more
      vi.advanceTimersByTime(1000);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(updates()).toBe(before + 1);
    });

  it("a key-up of a key that never panned, or a stop with nothing held, settles nothing", () => {
    const { settled, updates } = setup();
    const before = updates();
    up("KeyD");
    fire("blur");
    fire("keydown", { key: "Shift", code: "ShiftLeft" });
    vi.advanceTimersByTime(1000);
    expect(settled).not.toHaveBeenCalled();
    expect(updates()).toBe(before);
  });

  it("a wheel burst cut short by a key press updates once, at settle", () => {
    const { emit, updates } = setup();
    const before = updates();
    emit("moveend");
    vi.advanceTimersByTime(50);
    down("KeyS");
    vi.advanceTimersByTime(500);
    up("KeyS");
    vi.advanceTimersByTime(SETTLE_MS + 1000);
    expect(updates()).toBe(before + 1);
  });

  it("onSettle's removal stops the callback", () => {
    const { settled, off } = setup();
    off();
    down("KeyD"); up("KeyD");
    vi.advanceTimersByTime(1000);
    expect(settled).not.toHaveBeenCalled();
  });
});

describe("background mask reads wired to imagery.moving() (criterion 2)", () => {
  const W = 1200, H = 1100; // 5 bands of 256 rows
  const masks = () => samplesSource({ width: W, height: H, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10], bandCount: 4, alpha: 3, nodata: null, float: false },
    (k) => (k === 3 ? 255 : 100), { width: W, height: 1, bytes: W * 4 });

  it("wait during a hold and until 150 ms after the last move; stroke and hover reads still start", async () => {
    const { imagery, emit } = setup();
    const { source, reads } = masks();
    const cache = new MaskCache(source, { moving: imagery.moving, retryMs: 10 });
    down("KeyD");
    cache.start(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(reads).toEqual([]);
    const stroke = cache.need(2 * 256, STROKE);
    await vi.advanceTimersByTimeAsync(5);
    await stroke;
    const hover = cache.need(4 * 256, HOVER);
    await vi.advanceTimersByTimeAsync(5);
    await hover;
    const rows = () => new Set(reads.map((r) => Math.floor(r.y0 / 256)));
    expect([...rows()].sort()).toEqual([2, 4]);
    up("KeyD");
    emit("move"); // the last frame's move, just before the key-up
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 20);
    expect([...rows()].sort()).toEqual([2, 4]);
    await vi.advanceTimersByTimeAsync(200);
    expect(cache.finished).toBe(true);
    expect(rows().size).toBe(5);
  });
});
