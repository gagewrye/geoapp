// A FileSystemDirectoryHandle fake (spec 074): createWritable writes a swap buffer that replaces the file only on close, as WHATWG says.
type Entry = { bytes: Uint8Array };

export function fakeFolder(files: Record<string, Uint8Array> = {}, opts: { failAfter?: number } = {}) {
  const entries = new Map<string, Entry>(Object.entries(files).map(([k, v]) => [k, { bytes: v.slice() }]));
  const log: string[] = [];
  const notFound = () => new DOMException("A requested file or directory could not be found.", "NotFoundError");
  const fileHandle = (name: string): FileSystemFileHandle => {
    const h = {
      kind: "file", name,
      async isSameEntry(o: FileSystemHandle) { return (o as unknown as { entry?: Entry }).entry === entries.get(name) && o.name === name; },
      async getFile() { const e = entries.get(name); if (!e) throw notFound(); return new File([e.bytes.slice()], name); },
      async createWritable() {
        log.push(`createWritable ${name}`);
        const parts: Uint8Array[] = [];
        let writes = 0;
        return {
          async write(d: Uint8Array) {
            if (opts.failAfter !== undefined && ++writes > opts.failAfter) throw new DOMException("The disk failed.", "InvalidStateError");
            parts.push(d.slice());
          },
          async close() {
            const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
            let o = 0;
            for (const p of parts) { out.set(p, o); o += p.length; }
            const e = entries.get(name);
            if (e) e.bytes = out; else entries.set(name, { bytes: out });
            log.push(`close ${name}`);
          },
          async abort() { log.push(`abort ${name}`); },
        };
      },
    };
    Object.defineProperty(h, "entry", { get: () => entries.get(name) });
    return h as unknown as FileSystemFileHandle;
  };
  const dir = {
    kind: "directory", name: "folder",
    async getFileHandle(name: string, o: { create?: boolean } = {}) {
      if (!entries.has(name)) {
        if (!o.create) throw notFound();
        entries.set(name, { bytes: new Uint8Array(0) });
        log.push(`create ${name}`);
      }
      return fileHandle(name);
    },
    async removeEntry(name: string) { if (!entries.delete(name)) throw notFound(); log.push(`remove ${name}`); },
  } as unknown as FileSystemDirectoryHandle;
  return { dir, log, has: (n: string) => entries.has(n), bytes: (n: string) => entries.get(n)?.bytes ?? null, handle: fileHandle };
}
