import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoJSONStoreFeatures, GeoJSONStoreGeometries, TerraDraw } from "terra-draw";
import { grabsBody, translatedPastAntimeridian } from "../core/drag";
import type { BlockReason } from "./validation";

type Validate = (feature: GeoJSONStoreFeatures, context?: { updateType: string }) => { valid: boolean; reason?: string };
type FeatureId = string | number;
type Pt = [number, number];
type Session = {
  before: Map<FeatureId, GeoJSONStoreGeometries>;
  blocked: boolean;
  // set when the press grabs the polygon body: terra-draw will translate the whole ring
  bodyDrag: { ring: Pt[]; startLon: number } | null;
};

// terra-draw's default pointerDistance: vertices and midpoints within it win over the body.
const GRAB_PX = 40;

/**
 * Snaps a select-mode drag back to the geometry it started from if any update during it was
 * blocked, including a midpoint drag's inserted vertex (spec 001 criteria 14-15: the stored
 * polygon is unchanged). terra-draw alone keeps the last valid provisional position. It also
 * drops whole-polygon drags past +-180 without calling validation, so those are detected here.
 */
export function guardDrags(map: MapLibreMap, getDraw: () => TerraDraw | undefined, validate: Validate,
  onBlocked: (reason: BlockReason) => void): Validate {
  let session: Session | null = null;
  const local = (e: PointerEvent): Pt => {
    const r = map.getCanvas().getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const screen = (p: Pt): Pt => { const { x, y } = map.project(p); return [x, y]; };

  // Capture phase on the container runs before terra-draw's canvas listener, so this is pre-edit.
  map.getCanvasContainer().addEventListener("pointerdown", (e) => {
    const draw = getDraw();
    session = null;
    if (!draw || draw.getMode() !== "select") return;
    const features = draw.getSnapshot();
    const polygons = features.filter((f) => f.geometry.type === "Polygon" && f.id !== undefined);
    session = { before: new Map(polygons.map((f) => [f.id!, structuredClone(f.geometry)])), blocked: false, bodyDrag: null };
    const selected = polygons.find((f) => f.properties.selected);
    if (!selected) return;
    const ring = (selected.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
    const midpoints = features
      .filter((f) => f.properties.midPoint && f.properties.midPointFeatureId === selected.id)
      .map((f) => screen((f.geometry as GeoJSON.Point).coordinates as Pt));
    const p = local(e);
    if (grabsBody(ring.map(screen), midpoints, p, GRAB_PX)) session.bodyDrag = { ring, startLon: map.unproject(p).lng };
  }, { capture: true });

  window.addEventListener("pointermove", (e) => {
    const drag = session?.bodyDrag;
    if (!session || !drag || session.blocked || map.dragPan.isEnabled()) return; // not dragging the body
    if (translatedPastAntimeridian(drag.ring, map.unproject(local(e)).lng - drag.startLon)) {
      session.blocked = true;
      onBlocked("antimeridian");
    }
  });

  // Bubbling on window runs after terra-draw has finished the drag on the canvas.
  window.addEventListener("pointerup", () => {
    const s = session;
    session = null;
    const draw = getDraw();
    if (!draw || !s?.blocked) return;
    for (const [id, geometry] of s.before) {
      const now = draw.getSnapshotFeature(id);
      // updateFeatureGeometry also rebuilds the selection points and midpoints of a selected feature
      if (now && JSON.stringify(now.geometry) !== JSON.stringify(geometry)) draw.updateFeatureGeometry(id, geometry);
    }
  });

  return (feature, context) => {
    const result = validate(feature, context);
    if (!result.valid && session) session.blocked = true;
    return result;
  };
}
