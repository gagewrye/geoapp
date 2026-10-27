import { describe, expect, it, vi } from "vitest";
import { AEF_BANDS } from "../../../src/core/aef";
import type { CacheStore } from "../../../src/io/aefCache";
import { fakeOpfs } from "../helpers/fakeOpfs";

// Tester re-verification of F10: try to get a second tab onto the AlphaEarth cache folder.
// Each simulated tab is a fresh module copy (its own in-page guard) over one origin's fake OPFS and locks.
type CacheModule = typeof import("../../../src/io/aefCache");

async function tab(): Promise<CacheModule> {
  vi.resetModules();
  return import("../../../src/io/aefCache");
}

async function fill(store: CacheStore, v: number, size: number): Promise<void> {
  for (let b = 0; b < AEF_BANDS; b++) {
    const w = await store.band(b);
    await w.append(new Int8Array(size).fill(v));
    await w.close();
  }
}

/** One origin; `gate()` makes the next folder removals wait until `open()`, so a test can act mid-open. */
function origin() {
  const o = fakeOpfs();
  let removes = 0, wait: Promise<void> | undefined, open = () => {};
  const remove = o.root.removeEntry.bind(o.root);
  o.root.removeEntry = async (n, opts) => { removes++; if (wait) await wait; return remove(n, opts); };
  return {
    ...o, removes: () => removes, held: () => [...o.lockState.held],
    grants: () => o.lockState.log.filter((l) => l.event === "granted").length,
    gate: () => { wait = new Promise<void>((r) => { open = () => { wait = undefined; r(); }; }); },
    open: () => open(),
  };
}

const busy = (m: CacheModule) => (e: unknown) => expect(e).toBeInstanceOf(m.CacheBusyError);

describe("F10 lock: three tabs, races, replacements and failures (tester)", () => {
  it("three tabs: only the holder has the folder; it passes to whichever tab asks after the holder lets go", async () => {
    const o = origin();
    const a = await tab(), b = await tab(), c = await tab();
    const opts = { locks: o.locks };
    const sa = await a.opfsStore("aef-cache", o.handle, opts);
    await fill(sa, 1, a.PLANE_BYTES);
    const removes = o.removes();
    await b.opfsStore("aef-cache", o.handle, opts).then(() => { throw new Error("B opened"); }, busy(b));
    await c.opfsStore("aef-cache", o.handle, opts).then(() => { throw new Error("C opened"); }, busy(c));
    expect(o.removes(), "refused opens delete nothing").toBe(removes);
    expect((await sa.read(0))[63]![0]).toBe(1);
    await sa.discard();
    const sb = await b.opfsStore("aef-cache", o.handle, opts);
    await c.opfsStore("aef-cache", o.handle, opts).then(() => { throw new Error("C opened"); }, busy(c));
    await a.opfsStore("aef-cache", o.handle, opts).then(() => { throw new Error("A opened"); }, busy(a));
    await fill(sb, 2, a.PLANE_BYTES);
    await sb.discard();
    const sc = await c.opfsStore("aef-cache", o.handle, opts);
    await sc.discard();
    expect(o.held()).toEqual([]);
  });

  it("two tabs opening at the same moment: exactly one gets the folder, and only it deletes anything", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const [ra, rb] = await Promise.allSettled([
      a.opfsStore("aef-cache", o.handle, { locks: o.locks }), b.opfsStore("aef-cache", o.handle, { locks: o.locks }),
    ]);
    const won = [ra, rb].filter((r) => r.status === "fulfilled");
    const lost = [ra, rb].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0]!.reason as Error).message).toBe("Another tab holds the AlphaEarth cache.");
    expect(o.removes(), "one open's drop of the earlier cache").toBe(1);
    expect(o.grants()).toBe(1);
  });

  it("a chain of replacements in one tab is one lock grant, and another tab is refused at every step, even mid-open", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    let s = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    for (let i = 0; i < 3; i++) {
      await fill(s, i, a.PLANE_BYTES);
      o.gate(); // the replacement is inside opfsStore, deleting the old folder
      const next = a.opfsStore("aef-cache", o.handle, { locks: o.locks, replaces: s });
      await Promise.resolve();
      await b.opfsStore("aef-cache", o.handle, { locks: o.locks }).then(() => { throw new Error("B opened mid-replacement"); }, busy(b));
      expect(o.held(), "the lock is held mid-replacement").toEqual(["geoapp:opfs/aef-cache"]);
      o.open();
      s = await next;
      await b.opfsStore("aef-cache", o.handle, { locks: o.locks }).then(() => { throw new Error("B opened after replacement"); }, busy(b));
    }
    expect(o.grants(), "never released and retaken").toBe(1);
    expect(o.lockState.log.some((l) => l.event === "released")).toBe(false);
    await s.discard();
    expect(o.lockState.log.map((l) => l.event)).toEqual(["granted", "released"]);
  });

  it("two replacements of one store at once: one wins, the loser neither releases the lock nor frees the folder", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const old = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    const [r1, r2] = await Promise.allSettled([
      a.opfsStore("aef-cache", o.handle, { locks: o.locks, replaces: old }), a.opfsStore("aef-cache", o.handle, { locks: o.locks, replaces: old }),
    ]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    expect(o.held()).toHaveLength(1);
    await b.opfsStore("aef-cache", o.handle, { locks: o.locks }).then(() => { throw new Error("B opened"); }, busy(b));
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).rejects.toThrow("already in use");
    await (r1 as PromiseFulfilledResult<CacheStore>).value.discard();
    expect(o.held()).toEqual([]);
  });

  it("a refused open in this tab (in-page guard) makes no lock request and leaves the live store's lock alone", async () => {
    const o = origin();
    const a = await tab();
    const s = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).rejects.toThrow("already in use");
    expect(o.lockState.log).toEqual([{ name: "geoapp:opfs/aef-cache", event: "granted" }]);
    await fill(s, 5, a.PLANE_BYTES);
    expect((await s.read(0))[0]![0]).toBe(5);
  });

  it("a discard whose delete fails still releases the lock, once, and another tab can then open", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const s = await a.opfsStore("aef-cache", o.handle, { locks: o.locks });
    const w = await s.band(0);
    await w.append(new Int8Array(a.PLANE_BYTES)); // left open: the fake refuses to remove a folder with an open writable
    await expect(s.discard()).rejects.toThrow("open for writing");
    expect(o.held()).toEqual([]);
    await s.discard(); // a second discard is a no-op
    expect(o.lockState.log.map((l) => l.event)).toEqual(["granted", "released"]);
    await w.abort();
    const sb = await b.opfsStore("aef-cache", o.handle, { locks: o.locks });
    await fill(sb, 4, a.PLANE_BYTES);
    expect((await sb.read(0))[0]![0]).toBe(4);
  });

  it("with no Web Locks at all, an open fails with an error (not busy), frees the folder in this tab, and deletes nothing", async () => {
    const o = origin();
    const a = await tab();
    const e = await a.opfsStore("aef-cache", o.handle, { locks: undefined as unknown as LockManager }).then(() => null, (x: unknown) => x);
    // in Node 22, navigator.locks is absent, as in a browser without Web Locks
    expect((globalThis.navigator as { locks?: unknown } | undefined)?.locks).toBeUndefined();
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(a.CacheBusyError);
    expect(o.removes()).toBe(0);
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).resolves.toBeDefined();
  });

  it("a lock request that rejects in one tab doesn't block another tab", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    o.lockState.fail = new DOMException("no locks", "SecurityError");
    await expect(a.opfsStore("aef-cache", o.handle, { locks: o.locks })).rejects.toThrow("no locks");
    expect(o.held()).toEqual([]);
    const sb = await b.opfsStore("aef-cache", o.handle, { locks: o.locks });
    await a.opfsStore("aef-cache", o.handle, { locks: o.locks }).then(() => { throw new Error("A opened"); }, busy(a));
    await sb.discard();
  });

  it("folders are locked separately, under geoapp:opfs/<name>", async () => {
    const o = origin();
    const a = await tab(), b = await tab();
    const s1 = await a.opfsStore("one", o.handle, { locks: o.locks });
    const s2 = await b.opfsStore("two", o.handle, { locks: o.locks });
    expect(o.held().sort()).toEqual(["geoapp:opfs/one", "geoapp:opfs/two"]);
    await s1.discard(); await s2.discard();
  });
});
