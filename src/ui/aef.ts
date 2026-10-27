import type { Map as MapLibreMap } from "maplibre-gl";
import type { TerraDraw } from "terra-draw";
import type { Aoi } from "../core/aef";
import { aoiGrid, sameAoi } from "../core/aoi";
import { normalizeLon } from "../core/crs";
import { CacheBusyError, opfsStore, type CacheStore } from "../io/aefCache";
import { downloadAoi } from "../io/aefDownload";
import { loadYears } from "../io/aefIndex";
import { openAefFile } from "../io/aefLocal";
import { buildAefPreview } from "../io/aefPreview";
import type { RasterSource } from "../io/source";
import { removeAefPreview, setAefPreviewVisible, showAefPreview } from "../map/aefPreview";
import { fitToPreview } from "../map/preview";
import { MESSAGES } from "./messages";

/** "busy" while fetching or opening; "failed" after a fetch failed and nothing replaced it. */
export type AefState = "none" | "busy" | "loaded" | "failed";
type Loaded = { aoi: Aoi; source: RasterSource; store?: CacheStore; year?: number }; // a local file has no year
type Deps = {
  map: MapLibreMap; draw: () => TerraDraw | undefined; previewMaxSide: number;
  say: (text: string) => void; run: (task: () => Promise<void>) => Promise<void>; onState: (s: AefState) => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * AlphaEarth controls (spec 002): area, year, fetch, local file, preview and attribution. Only one
 * set of AlphaEarth data is loaded at a time, and nothing here reads labels.
 */
export function initAef({ map, draw, previewMaxSide, say, run, onState }: Deps) {
  const year = $<HTMLSelectElement>("aef-year"), fetchBtn = $<HTMLButtonElement>("aef-fetch");
  const preview = $<HTMLInputElement>("aef-preview"), attribution = $("aef-attribution"), info = $("aef-info");
  const openAef = $<HTMLInputElement>("open-aef");
  let area: Aoi | undefined;
  let refused = false; // the last area drawn was refused, so its message is showing
  let noIndex = false; // years.json failed or listed no years: nothing can be fetched
  let data: Loaded | undefined;
  let fetching: { aoi: Aoi; year: number } | undefined; // what a running fetch is for
  let state: AefState = "none";
  // the only place the AlphaEarth controls are enabled: while busy, nothing else can start (one operation at a time)
  const setState = (s: AefState) => {
    state = s;
    fetchBtn.disabled = !area || !year.value || s === "busy";
    openAef.disabled = s === "busy";
    // a new area or year replaces nothing until fetched, so say so while other data is loaded or loading
    const other = data ?? fetching;
    info.textContent = !area ? "" : `Area: ${area.width} x ${area.height} px, EPSG:${area.epsg}`
      + (!other ? "" : !sameAoi(other.aoi, area) ? " (not fetched yet; the loaded data is another area)"
        : other.year !== undefined && String(other.year) !== year.value ? ` (not fetched yet; the loaded data is for ${other.year})` : "");
    onState(s);
  };

  loadYears().then((years) => {
    if (!years.length) throw new Error("no AlphaEarth years");
    year.replaceChildren(...years.map((y) => new Option(String(y), String(y))));
    year.value = String(years.at(-1));
    setState(state);
  }).catch(() => { noIndex = true; say(MESSAGES.aefIndex); }); // Fetch stays disabled: no year to pick

  async function unload(): Promise<void> {
    removeAefPreview(map);
    preview.checked = false;
    preview.disabled = true;
    attribution.hidden = true;
    const old = data;
    data = undefined;
    await old?.store?.discard().catch(() => {}); // already gone is fine
  }

  async function show(d: Loaded, fit: boolean): Promise<void> {
    const p = await buildAefPreview(d.source, previewMaxSide); // reads only the cache or the local file
    showAefPreview(map, p);
    if (fit) fitToPreview(map, p.corners);
    data = d;
    preview.disabled = false;
    preview.checked = true;
    attribution.hidden = false;
    setState("loaded");
  }

  $("aef-draw").addEventListener("click", () => draw()?.setMode("rectangle"));
  year.addEventListener("change", () => setState(state));
  preview.addEventListener("change", () => setAefPreviewVisible(map, preview.checked));

  fetchBtn.addEventListener("click", () => {
    if (state === "busy" || !area || !year.value) return;
    const aoi = area, y = Number(year.value), before = state;
    fetching = { aoi, year: y };
    setState("busy"); // before any await, so a second click finds Fetch disabled
    return run(async () => {
      let store: CacheStore | undefined;
      try {
        // takes over this tab's cache and its cross-tab lock, so no other tab gets it in between; while
        // another tab holds it this is refused before anything here is unloaded
        store = await opfsStore("aef-cache", undefined, { replaces: data?.store });
        await unload(); // a replaced store's discard is a no-op
        setState("busy"); // the old data is gone, so the info line's note is now about this fetch
        say("Downloading embeddings...");
        await show({ aoi, source: await downloadAoi(aoi, y, store), store, year: y }, false);
      } catch (e) {
        fetching = undefined;
        if (e instanceof CacheBusyError) { setState(before); say(MESSAGES.aefOtherTab); return; }
        await store?.discard().catch(() => {}); // downloadAoi discards a partial cache; this covers the rest
        await unload(); // a failed open has already ended the replaced store
        setState("failed");
        throw e;
      }
      fetching = undefined; // show() made the fetched data the loaded data
      say("Embeddings downloaded.");
    });
  });

  openAef.addEventListener("change", () => {
    const file = openAef.files?.[0];
    if (!file) return;
    // the input is disabled while busy; a change that still arrives must not replace data mid-operation
    if (state === "busy") { openAef.value = ""; return; }
    const before = state;
    setState("busy");
    return run(async () => {
      say("");
      let opened: Loaded;
      try {
        opened = await openAefFile(file);
      } catch (e) {
        setState(before); // a refused file leaves the loaded data as it was
        throw e;
      }
      await unload();
      try {
        await show(opened, true);
      } catch (e) {
        setState("failed");
        throw e;
      }
      say("AlphaEarth file opened.");
    });
  });

  return {
    /** The loaded AlphaEarth data, or null. */
    current: (): { aoi: Aoi; source: RasterSource } | null => (data ? { aoi: data.aoi, source: data.source } : null),
    state: () => state,
    /** A rectangle finished: it replaces the area if aoiGrid accepts it; otherwise it is removed and the area kept. */
    areaDrawn(id: string | number): void {
      const d = draw();
      if (!d) return;
      const f = d.getSnapshotFeature(id);
      if (f?.geometry.type !== "Polygon") return;
      const g = aoiGrid(f.geometry.coordinates[0]!.map(([lon, lat]) => [normalizeLon(lon!), lat!] as [number, number]));
      if (g === "zones" || g === "size") {
        d.removeFeatures([id]); // the outline on the map is always the area
        say(MESSAGES[g]);
        refused = true;
        return;
      }
      const old = d.getSnapshot().filter((o) => o.properties.mode === "rectangle" && o.id !== id).map((o) => o.id!);
      if (old.length) d.removeFeatures(old);
      area = g;
      if (noIndex) say(MESSAGES.aefIndex); // the reason Fetch stays disabled for this area
      else if (refused) say("");
      refused = false;
      setState(state);
    },
  };
}
