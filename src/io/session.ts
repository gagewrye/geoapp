import type { LabelClass } from "../core/classes";
import { keyHash } from "../core/session";

/** A saved label session (spec 031): the record; its edit tiles and mask copy are stored apart. */
export type SessionRecord = {
  key: string; name: string; savedAt: number;
  classes: LabelClass[]; selected: number; opacity: number; visible: boolean;
  /** The imported mask's derived data (spec 014's MaskBase without the file); null when no mask is loaded. */
  // copyMissing: saved without a copy of this import's mask (spec 032), so a restore must not open any copy file
  base: { lut: Uint8Array; count: number; windows: string[]; values: Uint8Array; copyMissing?: boolean } | null;
};

/** Where sessions live: IndexedDB and OPFS in the app (ADR 0025), a Map-backed fake in tests. */
export interface SessionStore {
  get(key: string): Promise<SessionRecord | null>;
  putRecord(r: SessionRecord): Promise<void>;
  /** Writes (or, for null, deletes) the tiles in one transaction. */
  putTiles(key: string, tiles: [string, ArrayBuffer | null][]): Promise<void>;
  clearTiles(key: string): Promise<void>;
  /** Up to n tiles in key order, after tile key `after` (from the first when null). */
  tiles(key: string, after: string | null, n: number): Promise<[string, ArrayBuffer][]>;
  /** Deletes the record, its tiles and its mask copy. */
  delete(key: string): Promise<void>;
  list(): Promise<{ key: string; savedAt: number }[]>;
  /** Streams the mask file into the session's copy. */
  saveBase(key: string, file: Blob): Promise<void>;
  base(key: string): Promise<Blob | null>;
  /** Deletes the mask copy alone, if there is one. */
  deleteBase(key: string): Promise<void>;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error ?? new DOMException("Transaction aborted", "AbortError")); });
// [key] sorts before every [key, tile], and [key, []] after them: arrays sort after strings
const all = (key: string) => IDBKeyRange.bound([key], [key, []]);

/** The browser's session store (ADR 0025): database geoplatform v1 with stores sessions and tiles, mask copies in OPFS bases/. */
export async function openSessionStore(): Promise<SessionStore> {
  const open = indexedDB.open("geoplatform", 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("sessions", { keyPath: "key" });
    open.result.createObjectStore("tiles");
  };
  const db = await req(open);
  const bases = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("bases", { create: true });
  const name = (key: string) => `${keyHash(key)}.tif`;
  const tx = (stores: string[], mode: IDBTransactionMode) => db.transaction(stores, mode);

  return {
    async get(key) { return (await req(tx(["sessions"], "readonly").objectStore("sessions").get(key)) as SessionRecord | undefined) ?? null; },
    async putRecord(r) { const t = tx(["sessions"], "readwrite"); t.objectStore("sessions").put(r); await done(t); },
    async putTiles(key, tiles) {
      const t = tx(["tiles"], "readwrite"), s = t.objectStore("tiles");
      for (const [k, buf] of tiles) if (buf) s.put(buf, [key, k]); else s.delete([key, k]);
      await done(t);
    },
    async clearTiles(key) { const t = tx(["tiles"], "readwrite"); t.objectStore("tiles").delete(all(key)); await done(t); },
    async tiles(key, after, n) {
      const s = tx(["tiles"], "readonly").objectStore("tiles");
      const range = after === null ? all(key) : IDBKeyRange.bound([key, after], [key, []], true);
      const [keys, values] = await Promise.all([req(s.getAllKeys(range, n)), req(s.getAll(range, n))]);
      return keys.map((k, i) => [(k as [string, string])[1], values[i] as ArrayBuffer]);
    },
    async delete(key) {
      const t = tx(["sessions", "tiles"], "readwrite");
      t.objectStore("sessions").delete(key);
      t.objectStore("tiles").delete(all(key));
      await done(t);
      await (await bases()).removeEntry(name(key)).catch(() => {}); // a session without a mask has no copy
    },
    async list() {
      const records = (await req(tx(["sessions"], "readonly").objectStore("sessions").getAll())) as SessionRecord[];
      return records.map(({ key, savedAt }) => ({ key, savedAt }));
    },
    async saveBase(key, file) {
      // createWritable writes a swap file, swapped in on close, so a crash mid-copy keeps the old copy whole
      const w = await (await (await bases()).getFileHandle(name(key), { create: true })).createWritable();
      await file.stream().pipeTo(w);
    },
    async deleteBase(key) { await (await bases()).removeEntry(name(key)).catch(() => {}); },
    async base(key) {
      try { return await (await (await bases()).getFileHandle(name(key))).getFile(); } catch { return null; }
    },
  };
}
