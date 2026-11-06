import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { emptyStore } from "../../../src/core/labelStore";
import type { FillRead } from "../../../src/io/fill";
import type { MaskCache } from "../../../src/io/maskCache";
import type { PaintOp } from "../../../src/io/paintQueue";
import type { RasterSource } from "../../../src/io/source";
import { UndoHistory } from "../../../src/io/undoHistory";
import type { BrushMode } from "../../../src/map/brush";
import { initClickTools } from "../../../src/ui/clickTools";

// Spec 054 scope 2 and 3's wiring: which tool a click reaches, and what leaving a tool or opening a raster drops.
const { read } = vi.hoisted(() => ({ read: { gate: null as null | (() => void), calls: 0 } }));
vi.mock("../../../src/map/polygonLayer", () => ({ polygonLayer: () => ({ open() {}, show() {}, near: (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) <= 3 }) }));
vi.mock("../../../src/io/fill", async (original) => ({
  ...(await original<typeof import("../../../src/io/fill")>()),
  // every tile unlabelled and valid; each read waits for read.gate
  fillReader: (): FillRead => async (_k, t) => { read.calls++; await new Promise<void>((r) => { read.gate = r; }); return { labels: new Uint8Array(t.width * t.height), mask: "all" }; },
}));
afterEach(() => { read.gate = null; read.calls = 0; });

function setup() {
  const store = emptyStore(200, 200), history = new UndoHistory(() => store);
  const ops: PaintOp[] = [], log: string[] = [];
  const state = { mode: "pan" as BrushMode, pending: false };
  const tools = initClickTools({
    map: {} as MapLibreMap, store: () => store, imagery: () => ({}) as RasterSource, base: () => null, masks: () => ({}) as MaskCache,
    undo: { history, sync: () => log.push("undo.sync") }, push: (op) => ops.push(op), panel: { classes: () => [{ colour: "#f00" }], selected: () => 0 },
    locked: () => false, say: () => {}, modes: { mode: () => state.mode, request() {}, smartOff() {}, canSmart: () => false },
    toolChanged: () => log.push("tool"), edits: { strokeEnded: () => log.push("saved") }, onBusy: () => log.push("busy"), pending: () => state.pending,
  });
  tools.open({ width: 200, height: 200, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] });
  const to = (m: BrushMode) => { state.mode = m; tools.modeChanged(); };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { tools, ops, log, state, to, settle };
}
const TRI: [number, number][] = [[10, 10], [60, 10], [30, 50]];

describe("the click tools", () => {
  it("a click goes to the selected tool only: none in Pan or Paint, a fill in Fill, a corner in Polygon", async () => {
    const t = setup();
    for (const m of ["pan", "paint", "smart"] as BrushMode[]) { t.to(m); t.tools.click([5, 5], true); }
    expect([read.calls, t.tools.filling()]).toEqual([0, false]);
    t.to("polygon");
    for (const p of TRI) t.tools.click(p, true);
    expect(read.calls).toBe(0);
    expect(t.tools.keys.polygon.apply()).toBe(true);
    expect(t.ops).toHaveLength(1);
    expect(t.log.slice(-2)).toEqual(["undo.sync", "saved"]); // one ended stroke: Undo's buttons and the autosave follow
    t.ops[0]!.done!("ok");
    t.to("fill");
    t.tools.click([5, 5], false); // Shift means nothing to Fill
    expect([read.calls, t.tools.filling(), t.tools.reading()]).toEqual([1, true, true]);
  });

  it("while a fill is read Undo, Import and Export are told to wait, and again once it lands", async () => {
    const t = setup();
    t.to("fill");
    t.log.length = 0;
    t.tools.click([5, 5], true);
    expect(t.log).toEqual(["undo.sync", "busy", "tool"]);
    read.gate!();
    await t.settle();
    expect(t.ops).toHaveLength(1);
    expect(t.tools.filling()).toBe(true);
    t.log.length = 0;
    t.ops[0]!.done!("ok");
    expect(t.tools.filling()).toBe(false);
    expect(t.log).toEqual(["undo.sync", "busy", "tool"]);
    // labels.ts gates on it: Undo's blocked() and busy(), which Import and Export read
    const src = readFileSync("src/ui/labels.ts", "utf8");
    expect(src).toMatch(/blocked: \(\) => [^,\n]*tools\.filling\(\)/);
    expect(src).toMatch(/busy: \(\) => [^,\n]*tools\.filling\(\)/);
  });

  it("leaving Fill, or opening a raster, drops a fill still reading: nothing is pushed when its read ends", async () => {
    for (const leave of ["mode", "open"] as const) {
      const t = setup();
      t.to("fill");
      t.tools.click([5, 5], true);
      if (leave === "mode") t.to("pan"); else t.tools.open({ width: 200, height: 200, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] });
      expect(t.tools.filling()).toBe(false);
      read.gate!();
      await t.settle();
      expect(t.ops).toEqual([]);
    }
  });

  it("a fill doesn't start while strokes are queued", () => {
    const t = setup();
    t.to("fill");
    t.state.pending = true;
    t.tools.click([5, 5], true);
    expect([read.calls, t.tools.filling()]).toEqual([0, false]);
  });

  it("a right click steps a polygon back; leaving Polygon or opening a raster discards its outline", () => {
    const t = setup();
    t.to("polygon");
    for (const p of TRI) t.tools.click(p, true);
    t.tools.rightClick();
    expect(t.tools.keys.polygon.apply()).toBe(false); // 2 corners left
    t.tools.click(TRI[2]!, true);
    t.to("paint");
    t.to("polygon");
    expect(t.tools.keys.polygon.discard()).toBe(false); // nothing left to discard
    for (const p of TRI) t.tools.click(p, true);
    t.tools.open({ width: 200, height: 200, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] });
    expect(t.tools.keys.polygon.back()).toBe(false);
  });

  it("the status reads only for the selected tool: a fill landing after Fill was left doesn't mark Polygon as reading", async () => {
    const t = setup();
    t.to("fill");
    t.tools.click([5, 5], true);
    read.gate!();
    await t.settle();
    expect(t.tools.reading()).toBe(true);
    t.state.mode = "polygon"; // the mode as the status bar reads it, before modeChanged
    expect(t.tools.reading()).toBe(false);
  });
});
