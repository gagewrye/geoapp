import { describe, expect, it } from "vitest";
import { BLOCK, RangeSource } from "../../../src/io/rangeSource";
import { memFetch } from "../helpers/aefTiff";

// Tester replacement for the dropped header-block-cache peak assertion (review issue 7): the
// 16 MiB cap (256 blocks of 64 KiB) is checked through requests only. After reading blocks
// 0..299 one by one, an LRU cache of exactly 256 blocks holds 44..299 and has dropped 43.
const URL_ = "https://aef.test/v1/annual/2021/17N/h.tiff";
const N = 300;

describe("header block cache bound (tester, observable)", () => {
  it("keeps the 256 most recently used 64 KiB blocks and refetches the 257th most recent", async () => {
    const data = new Uint8Array(N * BLOCK).map((_, i) => i % 251);
    const { fetch, log } = memFetch(new Map([[URL_, data]]));
    const s = new RangeSource(URL_, fetch, BLOCK);
    const block = async (id: number) => new Uint8Array((await s.fetch([{ offset: id * BLOCK + 5, length: 10 }]))[0]!);
    for (let id = 0; id < N; id++) expect((await block(id))[0]).toBe(data[id * BLOCK + 5]);
    expect(log).toHaveLength(N);
    for (let id = N - 1; id >= N - 256; id--) await block(id); // all cached: no request
    expect(log).toHaveLength(N);
    await block(N - 257);
    expect(log).toHaveLength(N + 1);
    expect(log.at(-1)!.range).toEqual([(N - 257) * BLOCK, (N - 256) * BLOCK - 1]);
  });

  it("planned tiles do not enter the header cache, so they cannot push header blocks out", async () => {
    const data = new Uint8Array(N * BLOCK);
    const { fetch, log } = memFetch(new Map([[URL_, data]]));
    const s = new RangeSource(URL_, fetch, BLOCK);
    await s.fetch([{ offset: 0, length: 100 }]); // header block 0
    for (let id = 1; id < N; id++) { s.plan(id * BLOCK, BLOCK); await s.fetch([{ offset: id * BLOCK, length: BLOCK }]); s.release(id * BLOCK); }
    const n = log.length;
    await s.fetch([{ offset: 10, length: 50 }]);
    expect(log).toHaveLength(n); // block 0 still cached
  });
});
