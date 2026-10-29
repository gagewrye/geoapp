import type { AefEntry } from "../core/aef";
import type { Fetch } from "./aefRemote";

/** Static index from our own host (ADR 0006); requests reveal only the year and the UTM zone. */
const APP_BASE = import.meta.env.BASE_URL;

async function getJson<T>(path: string, fetchFn: Fetch, appBase: string): Promise<T | null> {
  const res = await fetchFn(`${appBase}aef-index/${path}`, { method: "GET" });
  // Static hosts answer a missing shard with 404; dev servers with their HTML page.
  if (res.status === 404 || (res.ok && !/json/.test(res.headers.get("Content-Type") ?? ""))) return null;
  if (!res.ok) throw new Error(`Couldn't load the AlphaEarth index (HTTP ${res.status}).`);
  return (await res.json()) as T;
}

/** Years the index covers, ascending. */
export async function loadYears(fetchFn: Fetch = fetch, appBase = APP_BASE): Promise<number[]> {
  return (await getJson<number[]>("years.json", fetchFn, appBase)) ?? [];
}

/** Index entries for one year and UTM zone; none when the shard does not exist. */
export async function loadShard(year: number, epsg: number, fetchFn: Fetch = fetch, appBase = APP_BASE): Promise<AefEntry[]> {
  return (await getJson<AefEntry[]>(`${year}/${epsg}.json`, fetchFn, appBase)) ?? [];
}
