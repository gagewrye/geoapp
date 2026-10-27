import type { Map as MapLibreMap } from "maplibre-gl";
import { TerraDraw, TerraDrawRectangleMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { normalizeLon } from "../core/crs";

/** Wraps unprojected longitudes into [-180, 180], so an area drawn on a world copy is the same area. */
class WrappingAdapter extends TerraDrawMapLibreGLAdapter<MapLibreMap> {
  constructor(map: MapLibreMap, private readonly onRestore: () => void) {
    super({ map });
  }

  // terra-draw re-enables dragRotate and dragPan on every pointerup, also in Paint mode, where the
  // brush keeps dragRotate off; the brush re-applies its handler state after each restore
  override setDraggability(enabled: boolean): void {
    super.setDraggability(enabled);
    if (enabled) this.onRestore();
  }

  override unproject(x: number, y: number): { lng: number; lat: number } {
    const { lng, lat } = super.unproject(x, y);
    return { lng: normalizeLon(lng), lat };
  }
}

/**
 * terra-draw for spec 002's area rectangle only (ADR 0009); "static" except while the area tool is
 * active. `onRestore` runs after terra-draw gives MapLibre's drag handlers back.
 */
// The outline is unfilled so the preview below stays visible.
export function createDraw(map: MapLibreMap, onRestore: () => void): TerraDraw {
  const draw = new TerraDraw({
    adapter: new WrappingAdapter(map, onRestore),
    modes: [new TerraDrawRectangleMode({ styles: { fillOpacity: 0, outlineColor: "#ffd400", outlineWidth: 2 } })],
  });
  draw.start();
  return draw;
}
