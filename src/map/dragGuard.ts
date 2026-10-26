import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoJSONStoreFeatures, GeoJSONStoreGeometries, TerraDraw } from "terra-draw";
import type { BlockReason } from "./validation";

type Validate = (feature: GeoJSONStoreFeatures, context?: { updateType: string }) => { valid: boolean; reason?: string };
type FeatureId = string | number;
type Xy = { x: number; y: number };
type Session = {
  before: Map<FeatureId, GeoJSONStoreGeometries> | null;
  blocked: boolean;
  // set when the press grabs the polygon body: terra-draw will translate the whole ring
  featureDrag: { ring: [number, number][]; startLon: number } | null;
};

// terra-draw's default pointerDistance: vertices and midpoints within it win over the body.
const GRAB_PX = 40;

/**
 * Snaps a select-mode drag back to its starting geometry if any update during it was blocked
 * (spec 001 criteria 14-15: blocked edits leave the stored polygon unchanged). terra-draw alone
 * keeps the last valid provisional position. It also drops whole-polygon drags past +-180
 * without calling validation, so those are detected here to show the message.
 */
export function guardDrags(map: MapLibreMap, getDraw: () => TerraDraw | undefined, validate: Validate,
  onBlocked: (reason: BlockReason) => void): Validate {
  let session: Session | null = null;
  const container = map.getCanvasContainer();
  const local = (e: PointerEvent): Xy => {
    const r = map.getCanvas().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Capture phase on the container runs before terra-draw's canvas listener.
  container.addEventListener("pointerdown", (e) => {
    const draw = getDraw();
    session = draw?.getMode() === "select" ? { before: null, blocked: false, featureDrag: null } : null;
    if (!session || !draw) return;
    const selected = draw.getSnapshot().find((f) => f.properties.selected && f.geometry.type === "Polygon");
    if (!selected) return;
    const ring = (selected.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
    if (grabsBody(map, ring, local(e))) {
      session.featureDrag = { ring, startLon: map.unproject([local(e).x, local(e).y]).lng };
      session.before = new Map([[selected.id!, structuredClone(selected.geometry)]]);
    }
  }, { capture: true });

  window.addEventListener("pointermove", (e) => {
    const drag = session?.featureDrag;
    if (!session || !drag || session.blocked || map.dragPan.isEnabled()) return; // not dragging the body
    const dLon = map.unproject([local(e).x, local(e).y]).lng - drag.startLon;
    if (drag.ring.some(([lon]) => Math.abs(lon + dLon) > 180)) {
      session.blocked = true;
      onBlocked("antimeridian");
    }
  });

  // Bubbling on window runs after terra-draw has finished the drag.
  window.addEventListener("pointerup", () => {
    const s = session;
    session = null;
    const draw = getDraw();
    if (!draw || !s?.blocked || !s.before) return;
    for (const [id, geometry] of s.before) {
      const now = draw.getSnapshotFeature(id);
      if (!now || JSON.stringify(now.geometry) === JSON.stringify(geometry)) continue;
      draw.updateFeatureGeometry(id, geometry);
      if (now.properties.selected) { draw.deselectFeature(id); draw.selectFeature(id); } // rebuild handles
    }
  });

  return (feature, context) => {
    // Drag movement is "provisional"; a midpoint insertion before it is its own committed edit.
    if (session && !session.before && context?.updateType === "provisional") {
      session.before = new Map((getDraw()?.getSnapshot() ?? [])
        .filter((f) => f.geometry.type === "Polygon" && f.id !== undefined)
        .map((f) => [f.id!, structuredClone(f.geometry)]));
    }
    const result = validate(feature, context);
    if (!result.valid && session) session.blocked = true;
    return result;
  };
}

/** True when a press at p drags the polygon body rather than a vertex or midpoint. */
function grabsBody(map: MapLibreMap, ring: [number, number][], p: Xy): boolean {
  const pts = ring.map((v) => map.project(v));
  const n = pts.length - 1; // closed ring
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    if (Math.hypot(a.x - p.x, a.y - p.y) < GRAB_PX) return false;
    if (Math.hypot((a.x + b.x) / 2 - p.x, (a.y + b.y) / 2 - p.y) < GRAB_PX) return false;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
