import { describe, expect, it } from "vitest";
import type { Grid } from "../../../src/core/types";
import { saveQueue } from "../../../src/ui/saveQueue";
import { newSession, type Session } from "../../../src/ui/sessionState";
import type { Snapshot } from "../../../src/ui/snapshot";
import { fakeSessionStore } from "../helpers/sessionStore";

// Spec 056: a raster's snapshot pending from an earlier open is never written over the session that opened it again.
const G: Grid = { width: 512, height: 512, epsg: 32633, gt: [0, 1, 0, 0, 0, -1] };
const snap = (id: string, raster: string): Snapshot => ({
  id, tiles: [["0,0", new Uint8Array(4).fill(1).buffer]], clear: false, file: null, savedAt: null, labelled: true, demote: null, drop: [],
  record: { id, raster, role: "current", exportedAt: null, name: "a.tif", classes: [], selected: 0, opacity: 1, visible: true, base: null },
});

function setup() {
  const fake = fakeSessionStore();
  let current: Session | null = null;
  const q = saveQueue({ store: async () => fake.store, current: () => current, save: () => {}, sync: () => {}, now: () => 1, yieldTask: async () => {}, time: () => "" });
  const write = async () => { q.enqueue(null, null); await q.idle(); };
  return { fake, q, write, open: (s: Session) => { current = s; } };
}

describe("a pending snapshot of the open raster from an earlier open", () => {
  it("waits while the open session's offer is unsettled, and never writes over its id once settled", async () => {
    const t = setup(), old = newSession("R", "a.tif", G), now = newSession("R", "a.tif", G);
    t.q.hold({ s: old, snap: snap("R", "R"), reason: "x" });
    t.open(now);
    await t.write();
    expect(t.fake.records.size).toBe(0);
    now.ready = true; // and its id is R too
    await t.write();
    expect(t.fake.records.size).toBe(0);
    expect(t.q.pending()).toHaveLength(1);
    now.id = "R#1";
    await t.write();
    expect(t.fake.records.has("R")).toBe(true);
    expect(t.q.pending()).toHaveLength(0);
  });

  it("another raster's is written as usual", async () => {
    const t = setup(), old = newSession("A", "a.tif", G);
    t.q.hold({ s: old, snap: snap("A", "A"), reason: "x" });
    t.open(newSession("B", "b.tif", G));
    await t.write();
    expect(t.fake.records.has("A")).toBe(true);
  });
});
