import type { Map as MapLibreMap } from "maplibre-gl";
import { applyLabelView, DEFAULT_LABEL_OPACITY } from "../map/layers";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The Opacity slider and Show labels checkbox (spec 016). They change how labels show, never the labels, so no lock disables them. */
export function initLabelView(map: MapLibreMap, onVisible: (visible: boolean) => void) {
  const range = $<HTMLInputElement>("label-opacity"), text = $("label-opacity-text"), show = $<HTMLInputElement>("show-labels");

  const showText = () => { text.textContent = `Opacity: ${range.value}%`; };
  const apply = () => {
    showText();
    applyLabelView(map, { opacity: Number(range.value) / 100, visible: show.checked });
    onVisible(show.checked);
  };
  // Opacity isn't saved: a reload starts at the default even where the browser restores form values.
  // No layer exists yet, and new ones start from the same default.
  range.value = String(Math.round(DEFAULT_LABEL_OPACITY * 100));
  show.checked = true;
  showText();
  range.addEventListener("input", apply); // live while dragging
  show.addEventListener("change", apply);

  return {
    /** Check Show labels if it isn't. */
    show(): void {
      if (!show.checked) { show.checked = true; apply(); }
    },
    /** A raster opened: labels show again; the opacity is kept for the page session. */
    reset(): void {
      show.checked = true;
      apply();
    },
  };
}
