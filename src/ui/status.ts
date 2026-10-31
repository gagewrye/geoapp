import type { Map as MapLibreMap } from "maplibre-gl";
import { pixelAt } from "../core/pixel";
import { formatLonLat, formatPixel, formatTool, formatZoom } from "../core/status";
import type { Grid } from "../core/types";
import type { BrushMode } from "../map/brush";

const $ = (id: string) => document.getElementById(id)!;

/** The status bar's cursor, zoom and tool fields (spec 032); the cursor fields update at most once a frame. */
export function initStatus(map: MapLibreMap, grid: () => Grid | null) {
  const lonlat = $("status-lonlat"), px = $("status-px"), zoom = $("status-zoom"), tool = $("status-tool");
  let at: { lng: number; lat: number } | null = null, frame = 0;

  const draw = () => {
    frame = 0;
    if (!at) { lonlat.textContent = px.textContent = ""; return; }
    lonlat.textContent = formatLonLat(at.lng, at.lat);
    const g = grid();
    let cell: [number, number] = [NaN, NaN];
    try { if (g) cell = pixelAt(g, at.lng, at.lat); } catch { /* off the CRS's area: no pixel */ }
    px.textContent = g ? formatPixel(g, cell) : "";
  };
  const later = () => { frame ||= requestAnimationFrame(draw); };
  map.on("mousemove", (e) => { at = e.lngLat; later(); });
  map.getCanvasContainer().addEventListener("mouseleave", () => { at = null; later(); });
  const showZoom = () => { zoom.textContent = formatZoom(map.getZoom()); };
  map.on("zoom", showZoom);
  showZoom();

  return {
    /** The brush mode, selected class or brush side changed. */
    tool(t: { mode: BrushMode; className: string; side: number } | null): void {
      tool.textContent = t ? formatTool(t.mode, t.className, t.side) : "";
    },
    /** A raster opened: the pixel field follows its grid from the next move. */
    refresh: later,
  };
}
