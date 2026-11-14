import { afterEach, describe, expect, it, vi } from "vitest";
import { canPickFolder, existingFile, folderSink, pickFolder, sameFile } from "../../../src/io/sink";
import { fakeFolder } from "../helpers/fakeFolder";

// Spec 055 (ADR 0035): the folder picker, with spec 050's startIn, and a sink that changes a file only on close.
describe("pickFolder", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const fakePicker = (result: () => Promise<unknown>) => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("showDirectoryPicker", (o: Record<string, unknown>) => { calls.push(o); return result(); });
    return calls;
  };

  it("asks for readwrite, passes the held handle as startIn and no id, and has no startIn key without one", async () => {
    const dir = fakeFolder().dir;
    const calls = fakePicker(async () => dir);
    const h = { kind: "file", name: "Chunk1_1.tif" } as unknown as FileSystemHandle;
    expect(await pickFolder(h)).toBe(dir);
    expect(calls[0]).toEqual({ mode: "readwrite", startIn: h });
    await pickFolder();
    expect(calls[1]).toEqual({ mode: "readwrite" });
    expect(canPickFolder()).toBe(true);
  });

  it("is null on AbortError and rethrows anything else", async () => {
    fakePicker(() => Promise.reject(new DOMException("aborted", "AbortError")));
    expect(await pickFolder()).toBe(null);
    fakePicker(() => Promise.reject(new DOMException("no gesture", "SecurityError")));
    await expect(pickFolder()).rejects.toThrow("no gesture");
  });

  it("canPickFolder is false without showDirectoryPicker", () => {
    vi.stubGlobal("showDirectoryPicker", undefined);
    expect(canPickFolder()).toBe(false);
  });
});

describe("folderSink", () => {
  it("leaves an existing file's bytes until close, then replaces them; size reads the written file", async () => {
    const f = fakeFolder({ "labels.tif": new Uint8Array([9, 9, 9]) });
    const sink = await folderSink(f.dir, "labels.tif");
    await sink.write(new Uint8Array([1, 2]));
    expect(f.bytes("labels.tif")).toEqual(new Uint8Array([9, 9, 9]));
    await sink.close();
    expect(f.bytes("labels.tif")).toEqual(new Uint8Array([1, 2]));
    expect(await sink.size()).toBe(2);
  });

  it("abort keeps an existing file's bytes, and removes a file it created", async () => {
    const f = fakeFolder({ "labels.tif": new Uint8Array([9]) });
    const a = await folderSink(f.dir, "labels.tif");
    await a.write(new Uint8Array([1]));
    await a.abort!();
    expect(f.bytes("labels.tif")).toEqual(new Uint8Array([9]));
    const b = await folderSink(f.dir, "new.tif");
    await b.write(new Uint8Array([1]));
    await b.abort!();
    expect(f.has("new.tif")).toBe(false);
  });

  it("existingFile is null for a missing name and creates nothing", async () => {
    const f = fakeFolder({ "a.tif": new Uint8Array(1) });
    expect(await existingFile(f.dir, "b.tif")).toBe(null);
    expect(f.has("b.tif")).toBe(false);
    expect(await existingFile(f.dir, "a.tif")).not.toBe(null);
  });
});

describe("sameFile", () => {
  it("compares with isSameEntry, is false without a handle, and true when the browser can't tell", async () => {
    const f = fakeFolder({ "a.tif": new Uint8Array(1), "b.tif": new Uint8Array(1) });
    const a = (await existingFile(f.dir, "a.tif"))!, b = (await existingFile(f.dir, "b.tif"))!;
    expect(await sameFile(a, (await existingFile(f.dir, "a.tif"))!)).toBe(true);
    expect(await sameFile(a, b)).toBe(false);
    expect(await sameFile(null, a)).toBe(false);
    const broken = { isSameEntry: () => Promise.reject(new DOMException("gone", "NotFoundError")) } as unknown as FileSystemHandle;
    expect(await sameFile(broken, a)).toBe(true);
  });
});
