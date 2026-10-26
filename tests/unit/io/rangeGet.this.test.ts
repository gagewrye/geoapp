import { describe, expect, it } from "vitest";
import { getRange } from "../../../src/io/rangeGet";

describe("getRange calls fetch as a plain function", () => {
  it("works with a fetch that, like the browser's, throws Illegal invocation when called as a method", async () => {
    // window.fetch rejects any `this` other than the global object or undefined
    const fetchFn = async function (this: unknown, _url: RequestInfo | URL, _init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return new Response(new Uint8Array(4), { status: 206, headers: { "Content-Range": "bytes 0-3/10" } });
    } as typeof globalThis.fetch;
    const r = await getRange({ url: "https://aef.test/x.tiff", fetchFn, start: 0, end: 3, size: null, timeoutMs: 1000 });
    expect([r.body.byteLength, r.total]).toEqual([4, 10]);
  });
});
