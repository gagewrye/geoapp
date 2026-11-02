import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { LabelClass } from "../../../src/core/classes";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { rasterKey, restoredPreview } from "../../../src/core/session";
import type { Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import type { MaskBase } from "../../../src/io/maskBase";
import { labelDisplay } from "../../../src/ui/labelDisplay";
import { initPersist, SAVE_DELAY_MS, type PersistLabels } from "../../../src/ui/persist";
import { fakeSessionStore } from "../helpers/sessionStore";

// Spec 048 criterion 8: a restore of a base plus 300 tiles shows the same preview values as before the reload,
// and the saved base values are the import's own.
const G: Grid = { width: 256 * 20, height: 256 * 16, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] }; // 320 tiles
const SIZE = 9876;

let frames: (() => void)[] = [];
const runFrames = () => { while (frames.length) frames.shift()!(); };

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData: () => {} }) }) });
  vi.stubGlobal("ImageData", class { data: Uint8ClampedArray; constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** A page: labels whose restoreSession swaps the store and base in and redraws, as labels.replace does. */
function page(fake: ReturnType<typeof fakeSessionStore>) {
  let store: LabelStore = emptyStore(G.width, G.height), base: MaskBase | null = null;
  const classes: LabelClass[] = [{ name: "A", colour: "#ff0000" }, { name: "B", colour: "#00ff00" }, { name: "C", colour: "#0000ff" }];
  const map = { addSource() {}, addLayer() {}, getSource: () => ({ setWarp() {}, play() {}, pause() {} }), getLayer: () => undefined,
    removeLayer() {}, removeSource() {}, getStyle: () => ({ layers: [] }), getLayersOrder: () => [],
    getBounds: () => ({ getWest: () => 0, getSouth: () => 0, getEast: () => 0, getNorth: () => 0 }) } as unknown as MapLibreMap;
  const display = labelDisplay(map, () => store, () => classes.map((c) => c.colour));
  display.open(G);
  const labels: PersistLabels = {
    store: () => store, classes: () => classes, selected: () => 0, view: () => ({ opacity: 0.6, visible: true }), base: () => base,
    stroking: () => false, hasLabels: () => true,
    restoreSession(s, _c, b) { const keys = [...store.tiles.keys(), ...s.tiles.keys()]; store = s; base = b; display.setMask(b?.preview ?? null); display.redraw(keys); },
  };
  const p = initPersist({ labels, open: async () => fake.store, state: { textContent: "" }, win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    yieldTask: async () => {}, now: () => Date.now(), confirm: () => true,
    openBase: async (blob) => ({ meta: { width: G.width, height: G.height }, blob } as unknown as LabelSource),
    time: () => "12:00", dateTime: () => "today" });
  return { p, display, get store() { return store; }, set: (s: LabelStore, b: MaskBase) => { store = s; base = b; display.setMask(b.preview); } };
}

describe("restored preview (spec 048 criterion 8)", () => {
  it("a restore of a base plus 300 tiles gives the same preview values, and the saved base values are the import's", { timeout: 60_000 }, async () => {
    const fake = fakeSessionStore();
    const a = page(fake);
    a.p.open("a.tif", SIZE, G);
    await a.p.offer();
    // the import: preview values with every class, then 300 painted tiles over them
    const preview = restoredPreview(G, new Uint8Array(0));
    preview.values = Uint8Array.from({ length: preview.width * preview.height }, (_, i) => i % 4);
    const imported = preview.values.slice();
    const base = { lut: new Uint8Array(256), count: 7, windows: new Set(["0,0"]), preview } as unknown as MaskBase;
    a.set({ width: G.width, height: G.height, tiles: new Map(), base: true }, base);
    a.p.imported(new Blob(["mask"]));
    const keys = tileWindows(G.width, G.height).slice(0, 300).map((w) => `${w.x0},${w.y0}`);
    keys.forEach((k, i) => a.store.tiles.set(k, new Uint8Array(65536).fill(i % 4)));
    a.p.tiles(keys);
    a.display.redraw(keys);
    runFrames();
    const before = a.display.previewValues()!.slice();
    expect(before).not.toEqual(imported);
    expect(preview.values).toEqual(imported); // the display never writes the base's own values
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); await a.p.idle();
    const record = [...fake.records.values()][0]!;
    expect(record.base!.values).toEqual(imported);

    // a reload: a new page, the same store
    const b = page(fake);
    b.p.open("a.tif", SIZE, G);
    await b.p.offer();
    runFrames();
    expect(b.store.tiles.size).toBe(300);
    expect(b.display.previewValues()).toEqual(before);
    expect(rasterKey(SIZE, G)).toBe(record.key);
  });
});
