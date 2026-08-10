/**
 * KAR-16.2 — the tab's persisted `seq` cursor, and the hydrate that fills it
 * (docs/12-frontend-architecture.md §3.2, docs/11-api-and-realtime.md §4.1).
 *
 * ## Why the client keeps its own cursor at all
 *
 * `Last-Event-ID` is sent by the browser on **its own automatic reconnect of a
 * connection that previously opened**, and in no other situation. Not after a
 * page reload. Not on the first connection of a session. And — the one that
 * bites in development — not when the first connection never opened, which is
 * exactly what happens when `DeFlowd` is restarting while a tab is up: the
 * stream fails to open, the daemon comes back, and the tab reconnects with no
 * cursor at all. **Verified 2026-08-02.**
 *
 * So the cursor is the client's, it lives here, and every connection carries it
 * in `?since=`. The server's precedence is `since` > `Last-Event-ID` > head
 * (§4.1), so the header remains belts-and-braces and never load-bearing.
 *
 * ## Two things this refuses to do
 *
 * **It never goes backwards.** A reconnect's backfill and a subscribe's backfill
 * both overlap what the tab already applied — that overlap is designed in, not
 * an error (§5) — and a cursor that took the lower number would ask for the same
 * window again on the next attempt, forever.
 *
 * **It never notices a gap.** `4, 5, 7` is a healthy log: `6` belongs to another
 * run, or to a transaction that rolled back and burned the `AUTOINCREMENT`
 * value, which SQLite never reissues (§4.2). Nothing here compares a `seq` to
 * its predecessor, and `test/no-gap-detection.test.ts` is what keeps that true.
 *
 * `sessionStorage` rather than `localStorage`: the cursor describes *this tab's*
 * applied position, and two tabs at different positions sharing one key would
 * each resume from the other's.
 */
import type { Event } from '@DeFlow/core';
import type { ApiClient } from '../api/client.ts';
import { type HydratePage, type HydrateResult, hydrateRun } from '../api/hydrate.ts';

/**
 * One key per tab, not one per run.
 *
 * `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT` over the whole `event` table, so
 * the number a stream resumes from is a property of the tab's position in the
 * global sequence. A per-run cursor would open the multiplexed connection at
 * whichever run happened to be furthest behind.
 */
export const CURSOR_STORAGE_KEY = 'DeFlow.cursor';

export interface Cursor {
  /** The highest `seq` this tab has applied. `0` means "everything". */
  read(): number;
  /** Moves to `seq` when it is higher, and returns the cursor either way. */
  advance(seq: number): number;
  /** Back to a cold start. For a tab deliberately re-hydrating from zero. */
  reset(): void;
}

/**
 * The tab's cursor, backed by `storage`.
 *
 * Reads go through the storage on every call rather than through a cached
 * field, so two `Cursor` objects over one storage — which is what the reload
 * simulation in the specs is — agree without a subscription between them.
 *
 * Every storage access is guarded. Safari's private mode throws on `setItem`,
 * and a full quota throws on any write; a tab that let that propagate would
 * lose its stream over a browser preference it cannot control. The in-memory
 * value is authoritative for the life of the object, so a refusing storage
 * degrades to "this tab resumes correctly until it is reloaded".
 */
export function openCursor(storage: Storage, key: string = CURSOR_STORAGE_KEY): Cursor {
  let held = readStored(storage, key);

  const write = (value: number): void => {
    held = value;
    try {
      storage.setItem(key, String(value));
    } catch {
      // See above: an unwritable storage costs this tab its resume across a
      // reload and nothing else. There is no correct action here beyond
      // carrying on.
    }
  };

  return {
    read: () => Math.max(held, readStored(storage, key)),
    advance(seq) {
      const current = Math.max(held, readStored(storage, key));
      if (seq > current) write(seq);
      return Math.max(held, current);
    },
    reset() {
      held = 0;
      try {
        storage.removeItem(key);
      } catch {
        // As above.
      }
    },
  };
}

function readStored(storage: Storage, key: string): number {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return 0;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export interface HydrateToCursorOptions {
  /**
   * Where to start folding, when that is not where the cursor is.
   *
   * The two are the same for a client resuming a projection set it still
   * holds. They are **not** the same after a reload: the tab's projections are
   * gone, so it has to fold the run from the beginning again, while the cursor
   * it persisted is still the right floor for the stream's `?since=`. Defaults
   * to the cursor.
   */
  readonly from?: number;
  /** Called for every event, in `seq` order, exactly once. */
  readonly apply: (event: Event) => void;
  /** One call per page, with `headSeq` as an honest denominator. */
  readonly onProgress?: (page: HydratePage) => void;
  /** A kind this build has never heard of. Diagnostics only — never a gap. */
  readonly onUnknownKind?: (kind: string, seq: number) => void;
  /** Page size. Omitted takes the server's own default. */
  readonly limit?: number;
}

/**
 * Hydrates `runId` from `cursor` to the head of its log, advancing `cursor` as
 * it goes.
 *
 * The **order** is the correctness requirement rather than an optimisation
 * (§4.1): a tab hydrates through `GET /api/runs/:id/events` until `more` is
 * false and only *then* opens the stream at the cursor it ended on. A tab that
 * opened the stream first and hydrated alongside it has no defined seam.
 *
 * The cursor is written page by page rather than once at the end so that a tab
 * closed halfway through a 12,000-event hydrate comes back where it stopped
 * instead of folding the whole run again.
 */
export async function hydrateToCursor(
  client: ApiClient,
  runId: string,
  cursor: Cursor,
  options: HydrateToCursorOptions,
): Promise<HydrateResult> {
  return hydrateRun(client, runId, {
    since: options.from ?? cursor.read(),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.onUnknownKind === undefined ? {} : { onUnknownKind: options.onUnknownKind }),
    apply: options.apply,
    onPage: (page) => {
      cursor.advance(page.cursor);
      options.onProgress?.(page);
    },
  });
}
