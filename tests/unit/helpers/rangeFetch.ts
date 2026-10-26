import { readFileSync } from "node:fs";
import { AEF_BASE } from "../../../src/core/aef";

export type Logged = { url: string; method: string; headers: Record<string, string>; credentials?: string; body: unknown };
/** Per request: undefined serves normally, a number answers with that status, "network" rejects like fetch does. */
export type Fault = (url: string, range: [number, number] | null) => number | "network" | undefined;

const FIXTURES = "tests/fixtures/aef";

/** The file a URL maps to: AEF_BASE paths -> fixture COGs, app-origin /aef-index/ -> fixture shards. */
function fileFor(url: string): string | null {
  if (url.startsWith(AEF_BASE)) return `${FIXTURES}/cogs/${url.slice(AEF_BASE.length)}`;
  if (url.startsWith("/aef-index/")) return `${FIXTURES}${url}`;
  return null;
}

/** Fake fetch over the AEF fixtures that answers Range GETs with 206 and logs every request. */
export function rangeFetch(fault: Fault = () => undefined) {
  const log: Logged[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    log.push({ url, method: init.method ?? "GET", headers, credentials: init.credentials, body: init.body });
    const m = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? "");
    const range: [number, number] | null = m ? [Number(m[1]), Number(m[2])] : null;
    const f = fault(url, range);
    if (f === "network") throw new TypeError("Failed to fetch");
    if (typeof f === "number") return new Response("error", { status: f });
    const path = fileFor(url);
    let data: Buffer;
    try {
      data = readFileSync(path ?? "/nonexistent");
    } catch {
      return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }
    const type = url.endsWith(".json") ? "application/json" : "image/tiff";
    if (!range) return new Response(new Uint8Array(data), { status: 200, headers: { "Content-Type": type } });
    const end = Math.min(range[1], data.length - 1);
    return new Response(new Uint8Array(data.subarray(range[0], end + 1)), {
      status: 206, headers: { "Content-Type": type, "Content-Range": `bytes ${range[0]}-${end}/${data.length}` },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, log };
}
