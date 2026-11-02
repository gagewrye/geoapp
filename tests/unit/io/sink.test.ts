import { afterEach, describe, expect, it, vi } from "vitest";
import { openSink } from "../../../src/io/sink";

// Spec 050 criterion 1: the Save dialog starts in the imagery's folder when a handle is held.
describe("openSink's Save dialog options", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const fakePicker = () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("showSaveFilePicker", (o: Record<string, unknown>) => {
      calls.push(o);
      return Promise.resolve({ createWritable: () => Promise.resolve({ write: () => Promise.resolve(), close: () => Promise.resolve() }) });
    });
    return calls;
  };
  const types = [{ description: "GeoTIFF", accept: { "image/tiff": [".tif"] } }];

  it("passes the held handle as startIn, with today's name and types and no id", async () => {
    const calls = fakePicker();
    const h = { kind: "file", name: "Chunk1_1.tif" } as unknown as FileSystemHandle;
    await openSink("labels.tif", h);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.startIn).toBe(h);
    expect(calls[0]!.suggestedName).toBe("labels.tif");
    expect(calls[0]!.types).toEqual(types);
    expect("id" in calls[0]!).toBe(false);
  });

  it("has no startIn key without a handle", async () => {
    const calls = fakePicker();
    await openSink("labels.tif");
    expect(calls[0]!).toEqual({ suggestedName: "labels.tif", types });
    expect("startIn" in calls[0]!).toBe(false);
    expect("id" in calls[0]!).toBe(false);
  });
});
