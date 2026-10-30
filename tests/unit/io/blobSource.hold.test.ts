import { describe, expect, it } from "vitest";
import { blobSource, MAX_FETCH } from "../../../src/io/blobSource";

// Spec 024 with spec 028: a mask-cache band's block bytes are read in one call and its capped reads served from them.
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 255);

function counted(data: Uint8Array<ArrayBuffer>) {
  const blob = new Blob([data]);
  const slices: [number, number][] = [];
  const slice = blob.slice.bind(blob);
  blob.slice = (start?: number, end?: number, type?: string) => { slices.push([start ?? 0, end ?? blob.size]); return slice(start, end, type); };
  return { blob, slices };
}

describe("blobSource.hold", () => {
  it("reads the held ranges in one call, serves slices inside them with no call, each in its own buffer, until released", async () => {
    const data = bytes(400_000);
    const { blob, slices } = counted(data);
    const src = blobSource(blob);
    const release = await src.hold([{ offset: 1000, length: 5000 }, { offset: 6000, length: 7000 }, { offset: 20_000, length: 100 }]);
    expect(slices).toEqual([[1000, 20_100]]);
    const inside = [{ offset: 1000, length: 5000 }, { offset: 7000, length: 10 }, { offset: 20_000, length: 100 }];
    const a = await src.fetch(inside), b = await src.fetch(inside);
    expect(slices).toHaveLength(1);
    a.forEach((buf, i) => expect(Buffer.from(buf).equals(Buffer.from(data.subarray(inside[i]!.offset, inside[i]!.offset + inside[i]!.length)))).toBe(true));
    new Uint8Array(a[0]!).fill(0);
    expect(Buffer.from(b[0]!).equals(Buffer.from(data.subarray(1000, 6000)))).toBe(true);
    // a slice partly outside is read from the file
    await src.fetch([{ offset: 19_000, length: 2000 }]);
    expect(slices).toHaveLength(2);
    release();
    await src.fetch([{ offset: 1000, length: 10 }]);
    expect(slices).toHaveLength(3);
  });

  it("splits a hold into calls of at most MAX_FETCH bytes, and clips ranges to the file", async () => {
    const n = MAX_FETCH + 300_000;
    const { blob, slices } = counted(bytes(n));
    const src = blobSource(blob);
    const release = await src.hold([{ offset: 0, length: MAX_FETCH }, { offset: MAX_FETCH, length: 400_000 }]);
    expect(slices).toEqual([[0, MAX_FETCH], [MAX_FETCH, n]]);
    release();
  });

  it("rejects a fetch of held bytes when its signal is already aborted", async () => {
    const src = blobSource(new Blob([bytes(10_000)]));
    await src.hold([{ offset: 0, length: 10_000 }]);
    const c = new AbortController(); c.abort();
    await expect(src.fetch([{ offset: 0, length: 10 }], c.signal)).rejects.toThrow("aborted");
  });
});
