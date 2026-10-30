import type { LngLat, Map as MapLibreMap } from "maplibre-gl";
import { wasdStep, type WasdKey } from "../core/wasd";

type Deps = {
  /** Focus is in a text field or select, where letters type (spec 009 WASD). */
  typing: (el: Element | null) => boolean;
  /** A paint or erase stroke is in progress. */
  stroking: () => boolean;
};

const WASD = new Set<string>(["KeyW", "KeyA", "KeyS", "KeyD"]);
const MODIFIERS = new Set(["Control", "Meta", "Alt", "Shift"]);
/** A keyboard pan has settled this long after its last key is released; tiles load then (spec 027). */
export const SETTLE_MS = 150;

/** Middle-button drag pan and held-WASD panning, in every mode (spec 009). */
// MapLibre leaves button 1 unused, so the middle pan is ours: its presses are stopped at the map
// container's capture phase and never reach MapLibre or the brush.
export function createNavigation(map: MapLibreMap, deps: Deps) {
  const root = map.getContainer(), container = map.getCanvasContainer();
  const onCanvas = (e: Event) => e.target instanceof Node && container.contains(e.target);

  let pan: { pointerId: number; grabbed: LngLat } | null = null;
  const endPan = () => { pan = null; container.classList.remove("middle-pan"); };
  const point = (e: PointerEvent): [number, number] => {
    const r = map.getCanvas().getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  root.addEventListener("mousedown", (e) => {
    if (e.button === 1 && onCanvas(e)) { e.preventDefault(); e.stopPropagation(); } // no autoscroll icon (Windows)
  }, { capture: true });
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 1 || e.pointerType !== "mouse" || !onCanvas(e)) return;
    e.stopPropagation();
    if (pan || deps.stroking()) return;
    pan = { pointerId: e.pointerId, grabbed: map.unproject(point(e)) };
    container.classList.add("middle-pan");
  }, { capture: true });
  root.addEventListener("pointerup", (e) => { if (e.button === 1) e.stopPropagation(); }, { capture: true });

  // Window capture runs first, so the pan sees every move and release wherever the pointer is.
  window.addEventListener("pointermove", (e) => {
    if (!pan || e.pointerId !== pan.pointerId) return;
    if (!(e.buttons & 4)) { endPan(); return; } // the release was lost
    // keep the grabbed lon/lat under the pointer; on the globe this turns it as a left-drag pan does
    const at = map.project(pan.grabbed), [x, y] = point(e);
    map.panBy([at.x - x, at.y - y], { animate: false });
  }, { capture: true });
  window.addEventListener("pointerup", (e) => { if (pan && e.pointerId === pan.pointerId && !(e.buttons & 4)) endPan(); }, { capture: true });
  window.addEventListener("pointercancel", (e) => { if (pan && e.pointerId === pan.pointerId) endPan(); }, { capture: true });

  const held = new Set<WasdKey>();
  let frame = 0, last = 0;
  const settles = new Set<() => void>();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const unsettle = () => { if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; } };
  // once the keys that panned are all up, settle after SETTLE_MS unless another press comes first
  const released = (wasMoving: boolean) => {
    if (!wasMoving || held.size) return;
    unsettle();
    settleTimer = setTimeout(() => { settleTimer = null; for (const cb of settles) cb(); }, SETTLE_MS);
  };
  const stop = () => { const was = held.size > 0; held.clear(); cancelAnimationFrame(frame); frame = 0; released(was); };
  const step = (t: number) => {
    const [dx, dy] = wasdStep(held, Math.max(0, t - last));
    last = t;
    if (dx || dy) map.panBy([dx, dy], { animate: false });
    frame = held.size ? requestAnimationFrame(step) : 0;
  };
  window.addEventListener("keydown", (e) => {
    if (MODIFIERS.has(e.key)) { stop(); return; }
    if (!WASD.has(e.code) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || deps.typing(document.activeElement)) return;
    e.preventDefault();
    unsettle();
    held.add(e.code as WasdKey);
    if (!frame) { last = performance.now(); frame = requestAnimationFrame(step); }
  });
  window.addEventListener("keyup", (e) => { if (held.delete(e.code as WasdKey)) released(true); });
  window.addEventListener("focusin", (e) => { if (deps.typing(e.target as Element)) stop(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") stop(); });
  window.addEventListener("blur", () => { stop(); endPan(); });

  return {
    /** A middle-button pan is in progress (the brush paints nothing meanwhile). */
    panning: () => pan !== null,
    /** A pan key is held: the map moves every frame, so tiles wait (spec 027). */
    moving: () => held.size > 0,
    /** Calls cb once, SETTLE_MS after the last held pan key is released; returns its removal. */
    onSettle(cb: () => void): () => void {
      settles.add(cb);
      return () => { settles.delete(cb); };
    },
  };
}
