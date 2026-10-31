import type { Map as MapLibreMap } from "maplibre-gl";
import { applyLabelView, DEFAULT_LABEL_OPACITY } from "../map/layers";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The Opacity slider and Show labels checkbox (spec 016), and the peek (spec 034). They change how labels show, never the labels, so no lock disables them. */
export function initLabelView(map: MapLibreMap, onVisible: (visible: boolean) => void, onChange: () => void = () => {}) {
  const range = $<HTMLInputElement>("label-opacity"), text = $("label-opacity-text"), show = $<HTMLInputElement>("show-labels");

  let peeking = false; // a held peek key hides the layers only: the checkbox and the saved view stay (spec 034)
  const showText = () => { text.textContent = `Opacity: ${range.value}%`; };
  const layers = () => applyLabelView(map, { opacity: Number(range.value) / 100, visible: show.checked && !peeking });
  const apply = () => {
    showText();
    layers();
    onChange();
  };
  // Only a visibility change reports, so dragging the slider while hidden doesn't select Pan on every event
  const toggled = () => { apply(); onVisible(show.checked); };
  // A reload starts at the default even where the browser restores form values; only a restored session
  // (spec 031) brings its opacity back. No layer exists yet, and new ones start from the same default.
  range.value = String(Math.round(DEFAULT_LABEL_OPACITY * 100));
  show.checked = true;
  showText();
  range.addEventListener("input", apply); // live while dragging
  show.addEventListener("change", toggled);

  return {
    /** Toggle Show labels, as a click on it does (spec 034's H). */
    toggle(): void { show.checked = !show.checked; toggled(); },
    /** Hide the layers while on, leaving the checkbox alone; true when this changed the peek (none starts while hidden already). */
    peek(on: boolean): boolean {
      if (on === peeking || (on && !show.checked)) return false;
      peeking = on;
      layers();
      return true;
    },
    peeking: () => peeking,
    /** Check Show labels if it isn't. */
    show(): void {
      if (!show.checked) { show.checked = true; toggled(); }
    },
    /** Opacity (0-1) and Show labels. */
    get: () => ({ opacity: Number(range.value) / 100, visible: show.checked }),
    /** Sets both, as a restored session saved them (spec 031). */
    set(opacity: number, visible: boolean): void {
      range.value = String(Math.round(opacity * 100));
      show.checked = visible;
      toggled();
    },
    /** A raster opened: labels show again; the opacity is kept for the page session. */
    reset(): void {
      show.checked = true;
      toggled();
    },
  };
}
