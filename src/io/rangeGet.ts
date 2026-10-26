export type Fetch = typeof globalThis.fetch;

/** Any failed COG request: a non-206 answer, a network error or a CORS failure (spec 002). */
export class AefDownloadError extends Error {
  constructor(readonly host: string, cause: unknown) {
    super(`Couldn't download embeddings from ${host}.`, { cause });
  }
}

/** How long a COG request may go without any progress (answer or body bytes) before it fails. */
export const IDLE_TIMEOUT_MS = 30_000;

export type RangeGet = {
  url: string; fetchFn: Fetch; start: number; end: number;
  /** File size from earlier answers, which this one must repeat. */
  size: number | null;
  timeoutMs: number; signal?: AbortSignal;
};

/**
 * One ranged GET that must come back as a 206 of exactly the asked bytes; returns them and the
 * file size. Any other answer, a network error or timeoutMs without progress is an AefDownloadError.
 */
export async function getRange(g: RangeGet): Promise<{ body: ArrayBuffer; total: number }> {
  const host = new URL(g.url).host;
  const fail = (e: unknown) => (e instanceof AefDownloadError ? e : new AefDownloadError(host, e));
  const ctl = new AbortController();
  let end: (e: unknown) => void = () => {};
  const ended = new Promise<never>((_, reject) => { end = reject; });
  ended.catch(() => {});
  // racing `ended` also stops waiting on a fetch that ignores the abort
  const abort = (e: unknown) => { end(e); ctl.abort(e); };
  const onAbort = () => abort(g.signal?.reason);
  if (g.signal?.aborted) onAbort();
  g.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort(new Error(`no data from ${g.url} for ${g.timeoutMs} ms`)), g.timeoutMs);
  };
  try {
    progress();
    const init: RequestInit = { method: "GET", headers: { Range: `bytes=${g.start}-${g.end}` }, credentials: "omit", signal: ctl.signal };
    // browsers report CORS failures as network errors
    // called unbound: as g.fetchFn(...) the browser's fetch would get `this` = g and throw Illegal invocation
    const fetchFn = g.fetchFn;
    const res = await Promise.race([fetchFn(g.url, init), ended]).catch((e: unknown) => { throw fail(e); });
    progress();
    // a 200 would mean the host ignored Range and is sending the whole multi-GB file
    if (res.status !== 206) throw fail(new Error(`HTTP ${res.status} for ${g.url}`));
    const { want, total } = expected(g, res.headers.get("Content-Range"), fail);
    const body = await readBody(res, want, progress, ended).catch((e: unknown) => { throw fail(e); }); // e.g. connection lost mid-body
    return { body, total };
  } finally {
    clearTimeout(timer);
    g.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Byte count a 206 must carry. Its Content-Range must start where asked, end where asked (or at
 * the last byte when the range runs past the file), and give the same file size every time;
 * otherwise its bytes are not the asked ones and would be decoded as the wrong pixels.
 */
function expected(g: RangeGet, contentRange: string | null, fail: (e: unknown) => Error): { want: number; total: number } {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
  const [s, e, total] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN];
  if (s !== g.start || g.start >= total || e !== Math.min(g.end, total - 1) || (g.size !== null && total !== g.size)) {
    throw fail(new Error(`Content-Range ${JSON.stringify(contentRange)} for bytes=${g.start}-${g.end} of ${g.url}`));
  }
  return { want: e - s + 1, total };
}

/** The body, which must be exactly `want` bytes; each chunk counts as progress. */
async function readBody(res: Response, want: number, progress: () => void, ended: Promise<never>): Promise<ArrayBuffer> {
  const out = new Uint8Array(want);
  let n = 0;
  const reader = res.body?.getReader();
  try {
    for (;;) {
      if (!reader) break;
      const { done, value } = await Promise.race([reader.read(), ended]);
      if (done) break;
      progress();
      if (n + value.length > want) throw new Error(`more than ${want} bytes for a ${want}-byte range`);
      out.set(value, n);
      n += value.length;
    }
  } catch (e) {
    reader?.cancel().catch(() => {});
    throw e;
  }
  if (n !== want) throw new Error(`${n} bytes for a ${want}-byte range`);
  return out.buffer;
}
