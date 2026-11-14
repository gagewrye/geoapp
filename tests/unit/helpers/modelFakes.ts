/** A fake Cache Storage and fetch for the model files (specs 046 and 055). */
type Serve = { status: number; size: number };

export function fakes() {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const caches = {
    async open(name: string) {
      const m = stores.get(name) ?? new Map<string, Uint8Array>();
      stores.set(name, m);
      return {
        async match(url: string) { const b = m.get(url); return b ? new Response(b.slice()) : undefined; },
        async put(url: string, r: Response) { m.set(url, new Uint8Array(await r.arrayBuffer())); },
        async delete(url: string | Request) { return m.delete(typeof url === "string" ? url : url.url); },
        async keys() { return [...m.keys()].map((u) => new Request(u)); },
      };
    },
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  const serve: Serve = { status: 200, size: 12 };
  /** Serves `serve.size` bytes in chunks of 4 (byte value = chunk number); a signal aborted between chunks errors the body. */
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    let i = 0, sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (init?.signal?.aborted) { c.error(new DOMException("aborted", "AbortError")); return; }
        if (sent >= serve.size) { c.close(); return; }
        const n = Math.min(4, serve.size - sent);
        sent += n;
        c.enqueue(new Uint8Array(n).fill(++i));
      },
    });
    return new Response(body, { status: serve.status, headers: { "content-length": String(serve.size) } });
  };
  return { stores, caches, fetch, calls, serve };
}
