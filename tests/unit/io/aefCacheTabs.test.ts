import { describe, expect, it, vi } from "vitest";
import { AEF_BANDS } from "../../../src/core/aef";
import type { CacheStore } from "../../../src/io/aefCache";
import { fakeOpfs } from "../helpers/fakeOpfs";

// Tester F10: OPFS is shared by every tab of the origin, so one tab at a time holds the cache,
// through a Web Locks lock held for the life of a store.
type CacheModule = typeof import("../../../src/io/aefCache");

/** A fresh copy of the cache module, as a second tab has: its own in-page guard, the origin's OPFS and locks. */
async function tab(): Promise<CacheModule> {
  vi.resetModules();
  return import("../../../src/io/aefCache");
}

/** Write one plane of `v` to every band, so window 0 reads back. */
async function fill(store: CacheStore, v: number, size: number): Promise<void> {
  for (let b = 0; b < AEF_BANDS; b++) {
    const w = await store.band(b);
    await w.append(new Int8Array(size).fill(v));
    await w.close();
  }
}

function origin() {
  const o = fakeOpfs();
  let removes = 0;
  const remove = o.root.removeEntry.bind(o.root);
  o.root.removeEntry = (n, opts) => { removes++; return remove(n, opts); };
  return { ...o, removes: () => removes, held: () => [...o.lockState.held] };
}

describe("one tab at a time holds the AlphaEarth cache (tester F10)", () => {
  it("a second tab is refused while the first tab's store is live, touches nothing, and opens once the first discards", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const sa = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    await fill(sa, 7, a.PLANE_BYTES);
    const removes = o.removes();
    const refused = await b.opfsStore("aef-cache", o.handle, { locks: o.locks }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(b.CacheBusyError);
    expect(o.removes(), "the refused open deleted nothing").toBe(removes);
    expect((await sa.read(0)).every((p) => p.every((v) => v === 7))).toBe(true);
    expect(o.held()).toHaveLength(1);
    await sa.discard();
    expect(o.held(), "discard releases the lock").toEqual([]);
    const sb = await b.opfsStore("aef-cache", o.handle, { locks: o.locks });
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).rejects.toBeInstanceOf(a.CacheBusyError);
    await sb.discard();
  });

  it("a failed open releases the lock", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const get = o.root.getDirectoryHandle.bind(o.root);
    o.root.getDirectoryHandle = async () => { throw new DOMException("denied", "SecurityError"); };
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).rejects.toThrow("denied");
    expect(o.held()).toEqual([]);
    o.root.getDirectoryHandle = get;
    await expect(b.opfsStore("aef-cache", o.handle, { locks: o.locks })).resolves.toBeDefined();
  });

  it("a lock request that fails gives up the folder in this tab too", async () => {
    const o = origin();
    const a = await tab();
    o.lockState.fail = new DOMException("no locks", "SecurityError");
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).rejects.toThrow("no locks");
    expect(o.removes()).toBe(0);
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).resolves.toBeDefined();
  });

  it("replacing this tab's store keeps the lock throughout, so no other tab gets it in between", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const old = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    await fill(old, 7, a.PLANE_BYTES);
    const next = a.opfsStore("aef-cache", o.handle, { locks: o.locks, replaces: old });
    await expect(b.opfsStore("aef-cache", o.handle, { locks: o.locks })).rejects.toBeInstanceOf(b.CacheBusyError);
    const fresh = await next;
    expect(o.lockState.log.map((l) => l.event)).toEqual(["granted"]);
    await expect(old.read(0)).rejects.toThrow("discarded");
    await old.discard(); // a no-op: the folder and the lock are the new store's
    expect(o.held()).toHaveLength(1);
    await fill(fresh, 3, a.PLANE_BYTES);
    expect((await fresh.read(0))[0]![0]).toBe(3);
    await fresh.discard();
    expect(o.held()).toEqual([]);
  });

  it("a replacement whose open fails releases the lock, and the replaced store is gone", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const old = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    const get = o.root.getDirectoryHandle.bind(o.root);
    o.root.getDirectoryHandle = async () => { throw new DOMException("denied", "SecurityError"); };
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks, replaces: old })).rejects.toThrow("denied");
    expect(o.held()).toEqual([]);
    await expect(old.band(0)).rejects.toThrow("discarded");
    o.root.getDirectoryHandle = get;
    await expect(b.opfsStore("aef-cache", o.handle, { locks: o.locks })).resolves.toBeDefined();
  });

  it("replacing a discarded store, or another tab's, is an ordinary open", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const old = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    await expect(b.opfsStore("aef-cache", o.handle, { locks: o.locks, replaces: old })).rejects.toBeInstanceOf(b.CacheBusyError);
    await fill(old, 1, a.PLANE_BYTES); // still live: only its own tab can replace it
    expect((await old.read(0))[0]![0]).toBe(1);
    await old.discard();
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks, replaces: old })).resolves.toBeDefined();
  });
});
