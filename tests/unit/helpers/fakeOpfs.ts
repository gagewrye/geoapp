import { fakeLocks } from "./fakeLocks";

/** One write to a file through a writable: file name, byte position and length. */
export type OpfsWrite = { file: string; at: number; bytes: number };

type Entry = { kind: "dir"; dir: FakeDir } | { kind: "file"; data: Uint8Array; writers: number };

/** In-memory OPFS directory: writables commit on close, like the real one, and log every write. */
export class FakeDir {
  readonly entries = new Map<string, Entry>();
  constructor(readonly log: OpfsWrite[] = []) {}

  async getDirectoryHandle(name: string, o: { create?: boolean } = {}) {
    let e = this.entries.get(name);
    if (!e && o.create) this.entries.set(name, (e = { kind: "dir", dir: new FakeDir(this.log) }));
    if (e?.kind !== "dir") throw new DOMException(`no directory ${name}`, "NotFoundError");
    return e.dir;
  }

  async getFileHandle(name: string, o: { create?: boolean } = {}) {
    let e = this.entries.get(name);
    if (!e && o.create) this.entries.set(name, (e = { kind: "file", data: new Uint8Array(0), writers: 0 }));
    if (e?.kind !== "file") throw new DOMException(`no file ${name}`, "NotFoundError");
    const f = e, log = this.log;
    return {
      async getFile() { return new File([f.data.slice()], name); },
      async createWritable() {
        const parts: Uint8Array[] = [];
        let at = 0;
        f.writers++;
        return {
          async write(d: ArrayBufferView) {
            const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
            log.push({ file: name, at, bytes: bytes.length });
            parts.push(bytes); at += bytes.length;
          },
          async close() {
            const all = new Uint8Array(at);
            let p = 0;
            for (const b of parts) { all.set(b, p); p += b.length; }
            f.data = all; f.writers--;
          },
          async abort() { f.writers--; },
        };
      },
    };
  }

  /** Refuses to remove a file with an open writable, as a locked OPFS file may be refused. */
  async removeEntry(name: string, o: { recursive?: boolean } = {}) {
    const e = this.entries.get(name);
    if (!e) throw new DOMException(`no entry ${name}`, "NotFoundError");
    if (e.kind === "dir" && e.dir.entries.size && !o.recursive) throw new DOMException(`${name} is not empty`, "InvalidModificationError");
    if (e.kind === "dir" ? e.dir.open() : e.writers) throw new DOMException(`${name} is open for writing`, "NoModificationAllowedError");
    this.entries.delete(name);
  }

  private open(): boolean {
    return [...this.entries.values()].some((e) => (e.kind === "dir" ? e.dir.open() : e.writers > 0));
  }
}

/** A fake OPFS root, typed as the handle opfsStore takes, with the origin's fake Web Locks. */
export function fakeOpfs() {
  const root = new FakeDir();
  const { fake, locks } = fakeLocks();
  return { root, handle: root as unknown as FileSystemDirectoryHandle, log: root.log, locks, lockState: fake };
}
