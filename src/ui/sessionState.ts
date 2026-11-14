import type { Grid } from "../core/types";
import type { MaskBase } from "../io/maskBase";
import type { SessionRecord } from "../io/session";
import { CopyFailed, type Snapshot } from "./snapshot";

// The open raster's saved-session state that ui/persist.ts keeps, and how a failed save's error reads (specs 031, 032, 075)

/** A session's export state, enough to know whether it may be dropped (spec 075). */
export type Summary = { id: string; savedAt: number; exportedAt: number | null };

/** The open raster's session: what changed since its last save, and whether it may save yet. */
export type Session = {
  raster: string; name: string; grid: Grid;
  /** The session the labels on the map save to (ADR 0042), and the raster's stored replaced ones (normally at most one). */
  id: string; replaced: Summary[];
  /** The saved sessions' lookup, started at open; settled once it resolves (a failed one resolves []). */
  lookup: Promise<SessionRecord[]>; settled: boolean; found: boolean;
  /** Its restore offer has been answered (or there was none): until then nothing saves over the saved one. */
  ready: boolean;
  /** A record of it is saved from this page, so labels going to none delete it. */
  owned: boolean;
  /** Its labels are saved, or on their way: an import then keeps them as the replaced session. */
  kept: boolean;
  tiles: Set<string>; record: boolean; clear: boolean; file: Blob | null;
  /** Something besides an export changed since the last snapshot, so the next save is a new savedAt. */
  touched: boolean;
  /** When the labels last changed (besides an export), saved or not: a replaced session is exported only if after it. */
  lastChange: number;
  savedAt: number | null; exportedAt: number | null;
  demote: string | null; drop: string[];
  /** The mask copy is left out until the next import: a quota error, or COPY_RETRIES failed retries (specs 032, 075). */
  noCopy: boolean;
  copyFails: number;
  /** The current import's mask copy is written (true too with no import since open or restore). */
  copied: boolean;
  /** Its failed snapshots' tiles not yet written since: if an import replaces the labels first, they are saved as the replaced session. */
  failed: Snapshot | null;
};

/** A snapshot whose write failed (spec 031 scope 8): kept and written before anything else. */
// copyFails: this snapshot's own failed copies, so a replaced session's never use up the open import's retries
export type Pending = { s: Session; snap: Snapshot; reason: string; copyFails?: number };

/** A snapshot whose mask copy is left out: its record says the copy is missing. */
export const withoutCopy = (p: Snapshot): Snapshot =>
  p.file ? { ...p, file: null, record: { ...p.record, base: p.record.base && { ...p.record.base, copyMissing: true } } } : p;
export const cause = (e: unknown) => (e instanceof CopyFailed ? e.reason : e);
export const isQuota = (e: unknown) => cause(e) instanceof DOMException && (cause(e) as DOMException).name === "QuotaExceededError";
export const reasonOf = (e: unknown) => isQuota(e) ? "the browser's storage is full" : e instanceof Error && e.message ? e.message : String(e);

/** A raster's session as opened: no saved session found yet, nothing changed, and nothing may save until its offer settles. */
export const newSession = (raster: string, name: string, grid: Grid): Session => ({
  raster, name, grid, id: raster, replaced: [], lookup: Promise.resolve([]), settled: false, found: false, ready: false, owned: false, kept: false,
  tiles: new Set(), record: false, clear: false, file: null, touched: false, savedAt: null, exportedAt: null, demote: null, drop: [],
  noCopy: false, copyFails: 0, copied: true, failed: null, lastChange: 0,
});

/**
 * What Import and Export tell the saved session: an import's mask file and base (copied, then read from the copy: ADR 0041);
 * why an import may not replace the labels (spec 075 scope 2); a flush of unsaved changes before a replace; a wait for
 * the import's copy, which resolves once written or failed (spec 074 scope 1); and a verified export's time (spec 075 scope 6).
 */
export type SessionHooks = {
  imported(file: File, base: MaskBase): void; replaceRefused(): string | null; flush(): void;
  waitCopy(): Promise<unknown>; exported(at: number): void;
  /** The user's file a restored base reads, its copy not written; null when none. */
  maskUncopied(): Blob | null;
};
