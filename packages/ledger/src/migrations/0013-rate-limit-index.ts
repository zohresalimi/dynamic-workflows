/**
 * Migration 0013 — a partial index over `provider.rate_limited`
 * (KAR-14.4 AC10).
 *
 * `DeFlow doctor` answers *"why is this provider unusable right now?"* from
 * the most recent rate-limit event per provider, and that question is about
 * **the machine**, not about a run: a limit tripped by yesterday's run is
 * exactly what makes today's plan unroutable. So the query has no `run_id`
 * predicate and cannot use `event_run_seq` — without this index it is a full
 * scan of the largest table in the ledger, on a data directory that keeps
 * every event of every run for ever.
 *
 * **Partial**, on the one kind. A rate limit is a rare event and an ordinary
 * index on `kind` would carry a row for every append the system has ever made,
 * paid for on the write path where it buys nothing. This one holds a handful of
 * rows and costs nothing to maintain — the same trade `process_live` makes in
 * migration 0005 and for the same reason.
 *
 * `DESC` on `seq` because every reader of it wants the latest first, and seq is
 * the only total order the ledger has (§1.2 — never `ts`, which is display
 * only and can move backwards across an NTP correction).
 */
import type { Migration } from '../migrate.ts';

export const migration0013RateLimitIndex: Migration = {
  id: 13,
  name: 'rate-limit-index',
  up(db) {
    db.exec(
      `CREATE INDEX event_rate_limited ON event(seq DESC) WHERE kind = 'provider.rate_limited'`,
    );
  },
};
