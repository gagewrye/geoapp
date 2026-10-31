import type { Map as MapLibreMap } from "maplibre-gl";
import type { Grid } from "../../../src/core/types";

/** A DOM-free stand-in for the map's elements: an EventTarget that is also the `Node` the brush checks for. */
export class FakeEl extends EventTarget {
  classList = { toggle() {} };
  style = { setProperty() {} };
  contains(n: unknown) { return n === this; }
}

/** Installs the globals createBrush reads (window, Node) and returns a fake map whose screen x, y is lon x, lat -y. */
export function fakeBrushMap(stub: (name: string, value: unknown) => void) {
  stub("window", new EventTarget());
  stub("Node", FakeEl);
  const canvas = new FakeEl(), container = new FakeEl();
  const handler = { enable() {}, disable() {} };
  const map = {
    getCanvasContainer: () => canvas,
    getContainer: () => container,
    getCanvas: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }),
    _camera: { transform: { isPointOnMapSurface: () => true } },
    unproject: (p: { x: number; y: number }) => ({ lng: p.x, lat: -p.y }),
    on() {},
    dragRotate: handler, doubleClickZoom: handler, boxZoom: handler,
  };
  /** Dispatches a pointer event on the canvas container (down) or the window (move, up). */
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, button = 0) => {
    const e = Object.assign(new Event(type), { pointerType: "mouse", pointerId: 1, button, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
    if (type === "pointerdown") canvas.dispatchEvent(e);
    else {
      Object.defineProperty(e, "target", { value: canvas });
      (globalThis.window as unknown as EventTarget).dispatchEvent(e);
    }
  };
  return { map: map as unknown as MapLibreMap, pointer };
}

/** A 4326 grid matching fakeBrushMap: pixel (c, r) at screen (c, r). */
export const BRUSH_GRID: Grid = { width: 50, height: 50, epsg: 4326, gt: [0, 1, 0, 0, 0, -1] };
