import { offers } from "../core/session";
import type { SessionRecord } from "../io/session";
import { MESSAGES } from "./messages";

/** What the restore questions decided: the session to restore, the one left as replaced, and the ones to delete. */
export type Choice = { restore: SessionRecord | null; replaced: SessionRecord | null; deleted: string[] };

/**
 * Spec 056's restore questions for a raster's saved sessions. The current one (else the replaced one) is offered;
 * a Cancel offers the replaced one instead, if any, then asks to delete; only an OK there deletes, so no single
 * Cancel loses labels. A restored replaced session swaps roles with the current one.
 */
export function chooseSession(records: SessionRecord[], ask: (text: string) => boolean, dateTime: (ms: number) => string): Choice {
  const order = offers(records).map((i) => records[i]!);
  const cur = order.find((r) => r.role === "current") ?? null, rep = order.find((r) => r.role === "replaced") ?? null;
  const first = cur ?? rep;
  if (!first) return { restore: null, replaced: null, deleted: [] };
  const other = first === cur ? rep : null;
  if (ask(MESSAGES.restore(dateTime(first.savedAt), first.name))) return { restore: first, replaced: other, deleted: [] };
  if (other && ask(MESSAGES.restoreReplaced(dateTime(other.savedAt)))) return { restore: other, replaced: first, deleted: [] };
  if (ask(MESSAGES.restoreDelete(dateTime(first.savedAt), first.name))) return { restore: null, replaced: other, deleted: [first.id] };
  return { restore: first, replaced: other, deleted: [] };
}
