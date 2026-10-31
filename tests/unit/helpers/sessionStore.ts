import type { SessionRecord, SessionStore } from "../../../src/io/session";

/** A Map-backed SessionStore (spec 031) that logs each call, e.g. "putTiles 3" or "clearTiles". */
export function fakeSessionStore() {
  const records = new Map<string, SessionRecord>();
  const tiles = new Map<string, Map<string, ArrayBuffer>>();
  const bases = new Map<string, Blob>();
  const log: string[] = [];
  const of = (key: string) => { if (!tiles.has(key)) tiles.set(key, new Map()); return tiles.get(key)!; };
  let fail: Error | null = null;
  const check = () => { if (fail) throw fail; };
  const store: SessionStore = {
    async get(key) { return records.get(key) ?? null; },
    async putRecord(r) { check(); log.push("putRecord"); records.set(r.key, structuredClone(r)); },
    async putTiles(key, list) {
      check();
      log.push(`putTiles ${list.length}`);
      for (const [k, buf] of list) if (buf) of(key).set(k, buf.slice(0)); else of(key).delete(k);
    },
    async clearTiles(key) { check(); log.push("clearTiles"); tiles.delete(key); },
    async tiles(key, after, n) {
      const keys = [...of(key).keys()].sort().filter((k) => after === null || k > after).slice(0, n);
      return keys.map((k) => [k, of(key).get(k)!.slice(0)]);
    },
    async delete(key) { log.push(`delete ${key}`); records.delete(key); tiles.delete(key); bases.delete(key); },
    async list() { return [...records.values()].map(({ key, savedAt }) => ({ key, savedAt })); },
    async saveBase(key, file) { check(); log.push("saveBase"); bases.set(key, file); },
    async base(key) { return bases.get(key) ?? null; },
    async deleteBase(key) { log.push("deleteBase"); bases.delete(key); },
  };
  return { store, records, tiles, bases, log, failWith: (e: Error | null) => { fail = e; } };
}
