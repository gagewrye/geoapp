import type { Map as MapLibreMap } from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { normalizeLon } from "../core/ring";
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

/** terra-draw with polygon drawing and select-mode editing, both behind one validation (ADR 0003). */
export function createDraw(map: MapLibreMap, onBlocked: (reason: BlockReason) => void): TerraDraw {
  const validation = ringValidation(onBlocked);
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
  draw.start();
  return draw;
}
