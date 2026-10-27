import type { Map as MapLibreMap } from "maplibre-gl";
import { TerraDraw, TerraDrawRectangleMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { normalizeLon } from "../core/crs";

/** Wraps unprojected longitudes into [-180, 180], so an area drawn on a world copy is the same area. */
class WrappingAdapter extends TerraDrawMapLibreGLAdapter<MapLibreMap> {
  override unproject(x: number, y: number): { lng: number; lat: number } {
    const { lng, lat } = super.unproject(x, y);
    return { lng: normalizeLon(lng), lat };
  }
}

/** terra-draw for spec 002's area rectangle only (ADR 0009); "static" except while the area tool is active. */
// The outline is unfilled so the preview below stays visible.
export function createDraw(map: MapLibreMap): TerraDraw {
  const draw = new TerraDraw({
    adapter: new WrappingAdapter({ map }),
    modes: [new TerraDrawRectangleMode({ styles: { fillOpacity: 0, outlineColor: "#ffd400", outlineWidth: 2 } })],
  });
  draw.start();
  return draw;
}
