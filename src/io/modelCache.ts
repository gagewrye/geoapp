/** Model files kept in Cache Storage (ADR 0032), under a name holding the pinned revision, so a new revision fetches afresh. */
export const MODEL_CACHE = "geoapp-sam2.1-hiera-tiny-814a066";

/** Every url is in the model cache. */
export async function cachedAll(urls: string[]): Promise<boolean> {
  const cache = await caches.open(MODEL_CACHE);
  for (const url of urls) if (!(await cache.match(url))) return false;
  return true;
}

/** A model file's bytes: from the cache, else fetched (same origin) with progress, and cached once complete. */
// A cancelled or failed download stores nothing, so the next use asks again.
export async function fetchCached(url: string, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<Uint8Array> {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${url} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const parts: Uint8Array[] = [];
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    onProgress((done += r.value.length), total);
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(done);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  await cache.put(url, new Response(bytes)); // Response copies a BufferSource itself
  return bytes;
}
