import type { Map as MapLibreMap } from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { normalizeLon } from "../core/ring";
import { guardDrags } from "./dragGuard";
import { ringValidation, type BlockReason } from "./validation";

/**
 * Wraps unprojected longitudes into [-180, 180]. terra-draw's select-mode drags silently drop
 * out-of-range coordinates before validation, so without this a drag across 180 on a world
 * copy is blocked but the user never sees why.
 */
class WrappingAdapter extends TerraDrawMapLibreGLAdapter<MapLibreMap> {
  override unproject(x: number, y: number): { lng: number; lat: number } {
    const { lng, lat } = super.unproject(x, y);
    return { lng: normalizeLon(lng), lat };
  }
}

/**
 * terra-draw ends a drag only on a pointerup over the canvas, so a release elsewhere (e.g. over
 * the panel) or a pointercancel (touch) leaves it dragging, and the drag guard never restores.
 * Capture routes off-canvas releases here; a cancelled feature drag gets a pointerup instead.
 */
function endDragsAnywhere(map: MapLibreMap) {
  const canvas = map.getCanvas();
  canvas.addEventListener("pointerdown", (e) => { if (e.isPrimary) canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointercancel", (e) => {
    // terra-draw disables map panning only while it drags a feature; otherwise a pointerup would be a click
    if (!e.isPrimary || map.dragPan.isEnabled()) return;
    const { pointerId, pointerType, clientX, clientY } = e;
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerId, pointerType, clientX, clientY }));
  });
}

/** terra-draw with polygon drawing and select-mode editing, both behind one validation (ADR 0003). */
export function createDraw(map: MapLibreMap, onBlocked: (reason: BlockReason) => void): TerraDraw {
  endDragsAnywhere(map);
  const ref: { draw?: TerraDraw } = {};
  const validation = guardDrags(map, () => ref.draw, ringValidation(onBlocked), onBlocked);
  const draw = new TerraDraw({
    adapter: new WrappingAdapter({ map }),
    modes: [
      new TerraDrawPolygonMode({ validation }),
      new TerraDrawSelectMode({
        flags: {
          polygon: {
            feature: {
              validation,
              draggable: true,
              // terra-draw's planar self-intersection check runs before validation and would
              // silently swallow a drag across 180 (the wrapped ring self-intersects), hiding the message
              selfIntersectable: true,
              coordinates: { draggable: true, midpoints: { draggable: true }, deletable: true },
            },
          },
        },
      }),
    ],
  });
  ref.draw = draw;
  draw.start();
  return draw;
}
