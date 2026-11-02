import { afterEach, describe, expect, it, vi } from "vitest";
import { canPickFiles, pickRaster } from "../../../src/io/filePick";

// Spec 050 criterion 2: the open picker's handle, a cancel, and other errors.
describe("pickRaster and canPickFiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns the first handle the picker gives, asking for GeoTIFFs", async () => {
    const a = { name: "a.tif" }, b = { name: "b.tif" };
    const calls: unknown[] = [];
    vi.stubGlobal("showOpenFilePicker", (o: unknown) => { calls.push(o); return Promise.resolve([a, b]); });
    expect(canPickFiles()).toBe(true);
    expect(await pickRaster()).toBe(a);
    expect(calls).toEqual([{ types: [{ description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } }] }]);
  });

  it("resolves null when the picker is cancelled (AbortError)", async () => {
    vi.stubGlobal("showOpenFilePicker", () => Promise.reject(new DOMException("The user aborted a request.", "AbortError")));
    expect(await pickRaster()).toBeNull();
  });

  it("rejects on any other error, such as SecurityError", async () => {
    const e = new DOMException("Must be handling a user gesture to show a file picker.", "SecurityError");
    vi.stubGlobal("showOpenFilePicker", () => { throw e; });
    await expect(pickRaster()).rejects.toBe(e);
  });

  it("canPickFiles is false without showOpenFilePicker", () => {
    expect("showOpenFilePicker" in globalThis).toBe(false);
    expect(canPickFiles()).toBe(false);
  });

  it("calls the picker before its first await, so the click's user activation reaches it", () => {
    let called = false;
    vi.stubGlobal("showOpenFilePicker", () => { called = true; return Promise.resolve([]); });
    void pickRaster();
    expect(called).toBe(true);
  });
});
