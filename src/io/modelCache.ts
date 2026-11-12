/** Model files kept in Cache Storage (ADR 0032), under a name holding the pinned revision, so a new revision fetches afresh. */
export const MODEL_CACHE = "geoapp-sam2.1-hiera-tiny-814a066";

/** A model file: its URL and its exact size in bytes (spec 055). */
export type ModelFile = { url: string; bytes: number };

/** A model file's response was not the file: not OK, or the wrong size. The message is for the log. */
export class ModelFileError extends Error {
  constructor(readonly url: string, detail: string) {
    super(`${url}: ${detail}`);
    this.name = "ModelFileError";
  }
}

/** The cached entry for file, if it has the file's size; a wrong-sized one is deleted. */
async function entry(cache: Cache, file: ModelFile): Promise<Blob | null> {
  const hit = await cache.match(file.url);
  if (!hit) return null;
  // a Blob's size doesn't need its bytes in memory
  const blob = await hit.blob();
  if (blob.size === file.bytes) return blob;
  await cache.delete(file.url);
  return null;
}

/** Every file is in the model cache with its size. */
export async function cachedAll(files: ModelFile[]): Promise<boolean> {
  const cache = await caches.open(MODEL_CACHE);
  for (const f of files) if (!(await entry(cache, f))) return false;
  return true;
}

/** Deletes every model cache entry whose URL isn't one of files', such as spec 046's same-origin copies. */
export async function pruneCache(files: ModelFile[]): Promise<void> {
  const cache = await caches.open(MODEL_CACHE);
  const keep = new Set(files.map((f) => f.url));
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
}

/** A model file's bytes: from the cache, else fetched with progress, checked, and cached once complete. */
// A cancelled, failed or wrong download stores nothing, so the next use asks again.
export async function fetchCached(file: ModelFile, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<Uint8Array> {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await entry(cache, file);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  // ADR 0035: the Hub gets no cookie and no page URL
  const res = await fetch(file.url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok || !res.body) throw new ModelFileError(file.url, `HTTP ${res.status}`);
  const parts: Uint8Array[] = [];
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    onProgress((done += r.value.length), file.bytes);
  }
  signal.throwIfAborted();
  if (done !== file.bytes) throw new ModelFileError(file.url, `${done} bytes, expected ${file.bytes}`);
  const bytes = new Uint8Array(done);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  await cache.put(file.url, new Response(bytes)); // Response copies a BufferSource itself
  return bytes;
}
