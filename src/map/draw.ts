import type { Map as MapLibreMap } from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { ringValidation, type BlockReason } from "./validation";

/** terra-draw with polygon drawing and select-mode editing, both behind one validation (ADR 0003). */
export function createDraw(map: MapLibreMap, onBlocked: (reason: BlockReason) => void): TerraDraw {
  const validation = ringValidation(onBlocked);
  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [
      new TerraDrawPolygonMode({ validation }),
      new TerraDrawSelectMode({
        flags: {
          polygon: {
            feature: {
              validation,
              draggable: true,
              coordinates: { draggable: true, midpoints: true, deletable: true },
            },
          },
        },
      }),
    ],
  });
  draw.start();
  return draw;
}
