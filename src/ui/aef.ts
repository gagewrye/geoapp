import type { Map as MapLibreMap } from "maplibre-gl";
import type { TerraDraw } from "terra-draw";
import type { Aoi } from "../core/aef";
import { aoiGrid } from "../core/aoi";
import { normalizeLon } from "../core/ring";
import { opfsStore, type CacheStore } from "../io/aefCache";
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
type Loaded = { aoi: Aoi; source: RasterSource; store?: CacheStore };
type Deps = {
  map: MapLibreMap; draw: () => TerraDraw | undefined; previewMaxSide: number;
  say: (text: string) => void; run: (task: () => Promise<void>) => Promise<void>; onState: (s: AefState) => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * AlphaEarth controls (spec 002): area, year, fetch, local file, preview and attribution. Only one
 * set of AlphaEarth data is loaded at a time, and nothing here reads polygons or labels.
 */
export function initAef({ map, draw, previewMaxSide, say, run, onState }: Deps) {
  const year = $<HTMLSelectElement>("aef-year"), fetchBtn = $<HTMLButtonElement>("aef-fetch");
  const preview = $<HTMLInputElement>("aef-preview"), attribution = $("aef-attribution"), info = $("aef-info");
  const openAef = $<HTMLInputElement>("open-aef");
  let area: Aoi | undefined;
  let refused = false; // the last area drawn was refused, so its message is showing
  let noIndex = false; // years.json failed or listed no years: nothing can be fetched
  let data: Loaded | undefined;
  let state: AefState = "none";
  // the only place the AlphaEarth controls are enabled: while busy, nothing else can start (one operation at a time)
  const setState = (s: AefState) => {
    state = s;
    fetchBtn.disabled = !area || !year.value || s === "busy";
    openAef.disabled = s === "busy";
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
    const aoi = area, y = Number(year.value);
    setState("busy"); // before any await, so a second click finds Fetch disabled
    return run(async () => {
      let store: CacheStore | undefined;
      try {
        await unload();
        say("Downloading embeddings...");
        store = await opfsStore();
        await show({ aoi, source: await downloadAoi(aoi, y, store), store }, false);
      } catch (e) {
        await store?.discard().catch(() => {}); // downloadAoi discards a partial cache; this covers the rest
        setState("failed");
        throw e;
      }
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
      info.textContent = `Area: ${g.width} x ${g.height} px, EPSG:${g.epsg}`;
      if (noIndex) say(MESSAGES.aefIndex); // the reason Fetch stays disabled for this area
      else if (refused) say("");
      refused = false;
      setState(state);
    },
  };
}
