import { offers, sessionId } from "../core/session";
import type { SessionRecord, SessionStore } from "../io/session";
import { MESSAGES } from "./messages";
import type { Session } from "./sessionState";

/** What the restore questions decided: the session to restore, the one left as replaced, and the ones to delete. */
export type Choice = { restore: SessionRecord | null; replaced: SessionRecord | null; deleted: string[] };

/**
 * Spec 075's restore questions for a raster's saved sessions. The current one (else the newest replaced one) is offered;
 * a Cancel offers each replaced one instead, newest first, then asks to delete; only an OK there deletes, so no single
 * Cancel loses labels. A restored replaced session swaps roles with the current one (`replaced`, to demote).
 */
export function chooseSession(records: SessionRecord[], ask: (text: string) => boolean, dateTime: (ms: number) => string): Choice {
  const order = offers(records).map((i) => records[i]!);
  const cur = order.find((r) => r.role === "current") ?? null, reps = order.filter((r) => r.role === "replaced");
  const first = cur ?? reps[0];
  if (!first) return { restore: null, replaced: null, deleted: [] };
  const demote = first === cur ? first : null;
  if (ask(MESSAGES.restore(dateTime(first.savedAt), first.name))) return { restore: first, replaced: null, deleted: [] };
  for (const other of reps) {
    if (other !== first && ask(MESSAGES.restoreReplaced(dateTime(other.savedAt)))) return { restore: other, replaced: demote, deleted: [] };
  }
  if (ask(MESSAGES.restoreDelete(dateTime(first.savedAt), first.name))) return { restore: null, replaced: null, deleted: [first.id] };
  return { restore: first, replaced: null, deleted: [] };
}

/** Applies a choice to the store (deletes, then role swaps) and to the session: which id the labels save to (none of `taken`), and its replaced ones. */
export async function settle(s: Session, sessions: SessionStore, c: Choice, records: SessionRecord[], taken: string[] = []): Promise<SessionRecord | null> {
  for (const id of c.deleted) await sessions.delete(id);
  if (c.replaced && c.replaced.role !== "replaced") await sessions.putRecord({ ...c.replaced, role: "replaced" });
  if (c.restore && c.restore.role !== "current") await sessions.putRecord({ ...c.restore, role: "current" });
  const kept = records.filter((r) => !c.deleted.includes(r.id)), left = kept.map((r) => r.id);
  s.replaced = kept.filter((r) => r !== c.restore && (r.role === "replaced" || r === c.replaced)).map(({ id, savedAt, exportedAt }) => ({ id, savedAt, exportedAt }));
  s.id = c.restore?.id ?? sessionId(s.raster, [...left, ...taken]);
  if (c.restore) { s.savedAt = c.restore.savedAt; s.exportedAt = c.restore.exportedAt; }
  return c.restore;
}
