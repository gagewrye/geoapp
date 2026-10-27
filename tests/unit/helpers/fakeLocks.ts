/** One grant or release of a fake lock, in order. */
export type LockEvent = { name: string; event: "granted" | "released" };

/**
 * In-memory Web Locks manager shared by simulated tabs: exclusive `ifAvailable` requests only,
 * the kind the AlphaEarth cache makes; `fail` makes the next request reject.
 */
export function fakeLocks() {
  const held = new Set<string>();
  const log: LockEvent[] = [];
  const fake = {
    held, log, fail: undefined as Error | undefined,
    async request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
      if (!options.ifAvailable || (options.mode ?? "exclusive") !== "exclusive" || options.steal) throw new Error("fakeLocks: only exclusive ifAvailable requests");
      if (fake.fail) { const e = fake.fail; fake.fail = undefined; throw e; }
      if (held.has(name)) return callback(null);
      held.add(name);
      log.push({ name, event: "granted" });
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        held.delete(name);
        log.push({ name, event: "released" });
      }
    },
  };
  return { fake, locks: fake as unknown as LockManager };
}
