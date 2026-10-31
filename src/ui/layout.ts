import type { Map as MapLibreMap } from "maplibre-gl";
import { inTextField } from "./labelKeys";

const KEY = "geoplatform.collapsed";
const $ = (id: string) => document.getElementById(id)!;

/** The three regions (spec 035): side columns shown once a raster opens, and `\` collapses them, kept across reloads. */
export function initLayout({ map, open }: { map: MapLibreMap; open: () => boolean }) {
  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === "1"; } catch { /* storage off: start expanded */ }
  // the canvas keeps its old size until MapLibre is told the container changed
  const apply = () => { document.body.classList.toggle("collapsed", collapsed); map.resize(); };
  apply();
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Backslash" || e.repeat || !open() || e.ctrlKey || e.metaKey || e.altKey || inTextField(document.activeElement)) return;
    e.preventDefault();
    collapsed = !collapsed;
    try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch { /* not kept; the toggle still applies */ }
    apply();
  });

  return {
    /** A raster opened: the tool strip, the right panel and the label file actions show. */
    opened(): void {
      for (const id of ["tools", "side", "file-actions"]) $(id).hidden = false;
      map.resize();
    },
  };
}
