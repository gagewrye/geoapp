import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { ImagerySource } from "../../../src/io/source";
import { createNavigation, SETTLE_MS } from "../../../src/map/navigation";
import { initImagery } from "../../../src/ui/imagery";
import { fakeSource } from "../helpers/sources";

// Spec 027 criteria 1 and 2 (the map-moving signal): WASD pans start no tile updates; one update once it settles.
type Handler = (e: { code?: string; key?: string; preventDefault?: () => void }) => void;
const listeners = new Map<string, Handler[]>();
const on = (type: string, f: Handler) => { listeners.set(type, [...(listeners.get(type) ?? []), f]); };
const fire = (type: string, e: Parameters<Handler>[0] = {}) => listeners.get(type)?.forEach((f) => f({ preventDefault() {}, ...e }));

function fakeMap() {
  const events = new Map<string, (() => void)[]>();
  let bounds = 0;
  const node = { addEventListener() {}, contains: () => false, classList: { add() {}, remove() {} } };
  const map = {
    on: (e: string, f: () => void) => { events.set(e, [...(events.get(e) ?? []), f]); },
    getBounds: () => { bounds++; return { getWest: () => 15, getSouth: () => 45, getEast: () => 15.01, getNorth: () => 45.01 }; },
    getContainer: () => ({ ...node, clientWidth: 800, clientHeight: 600 }),
    getCanvasContainer: () => node,
    getCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    panBy: () => { emit("move"); emit("moveend"); }, // panBy with animate: false moves and ends at once
    isMoving: () => false,
    addSource() {}, addLayer() {}, getLayersOrder: () => [], getStyle: () => ({ layers: [] }),
  };
  const emit = (e: string) => events.get(e)?.forEach((f) => f());
  return { map: map as unknown as MapLibreMap, emit, updates: () => bounds };
}

const source = (): ImagerySource => {
  const { source: inner } = fakeSource({ width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }, () => 1);
  return { ...inner, overviews: [], block: { width: 256, height: 256, bytes: 256 * 256 * 12 }, readSamples: () => new Promise(() => {}) };
};

/** The app's wiring (ui/main.ts): imagery reads the navigation's moving() and updates on its settle. */
function setup() {
  const { map, emit, updates } = fakeMap();
  let nav: ReturnType<typeof createNavigation> | null = null;
  const imagery = initImagery(map, () => {}, { moving: () => nav?.moving() ?? false });
  nav = createNavigation(map, { typing: () => false, stroking: () => false });
  nav.onSettle(imagery.settle);
  imagery.open(source(), [[0, 1], [0, 1], [0, 1]]);
  return { nav, imagery, emit, updates };
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

describe("steady keyboard pan (spec 027)", () => {
  it(`settles once, ${SETTLE_MS} ms after the last pan key is released`, () => {
    const { nav } = setup();
    const settled = vi.fn();
    nav.onSettle(settled);
    expect(nav.moving()).toBe(false);
    fire("keydown", { code: "KeyD", key: "d" });
    expect(nav.moving()).toBe(true);
    vi.advanceTimersByTime(500);
    fire("keyup", { code: "KeyD", key: "d" });
    expect(nav.moving()).toBe(false);
    vi.advanceTimersByTime(100);
    fire("keydown", { code: "KeyW", key: "w" }); // a new press before the settle restarts it
    fire("keyup", { code: "KeyW", key: "w" });
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("criterion 1: moveend while a pan key is held starts no update; one update runs 150 ms after release", () => {
    const { updates } = setup();
    const before = updates();
    fire("keydown", { code: "KeyD", key: "d" });
    vi.advanceTimersByTime(1000); // about 60 pan frames, each a moveend
    expect(updates()).toBe(before);
    fire("keyup", { code: "KeyD", key: "d" });
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(updates()).toBe(before);
    vi.advanceTimersByTime(1);
    expect(updates()).toBe(before + 1);
    vi.advanceTimersByTime(1000);
    expect(updates()).toBe(before + 1);
  });

  it("criterion 1: five wheel moveend events 20 ms apart cause one update, 150 ms after the last", () => {
    const { emit, updates } = setup();
    const before = updates();
    for (let i = 0; i < 5; i++) { emit("moveend"); vi.advanceTimersByTime(20); }
    expect(updates()).toBe(before);
    vi.advanceTimersByTime(SETTLE_MS - 20 - 1);
    expect(updates()).toBe(before);
    vi.advanceTimersByTime(1);
    expect(updates()).toBe(before + 1);
    vi.advanceTimersByTime(1000);
    expect(updates()).toBe(before + 1);
  });

  it("criterion 2: the map counts as moving while a pan key is held and until 150 ms after its last move", () => {
    const { imagery, emit } = setup();
    expect(imagery.moving()).toBe(false);
    fire("keydown", { code: "KeyD", key: "d" });
    expect(imagery.moving()).toBe(true);
    vi.advanceTimersByTime(300);
    fire("keyup", { code: "KeyD", key: "d" });
    expect(imagery.moving()).toBe(true); // its last move was under 150 ms ago
    vi.advanceTimersByTime(SETTLE_MS);
    expect(imagery.moving()).toBe(false);
    emit("move"); // a drag or wheel step
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(imagery.moving()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(imagery.moving()).toBe(false);
  });
});
