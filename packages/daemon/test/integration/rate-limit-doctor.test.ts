/**
 * KAR-14.4 AC10 — `deflow doctor`, per provider: the most recent
 * `provider.rate_limited` and its `resetsAt`.
 *
 * The question this answers is *"why is this provider unusable right now?"*,
 * and an operator has to be able to answer it without opening a run — a rate
 * limit is a fact about a binary on this machine, not about the run that
 * happened to trip it, and it outlives every run that read it.
 *
 * The one thing it must never do is fill in a reset time. `provider.rate_limited`
 * carries `resetsAt` as optional precisely because half the paths that reach it
 * do not have one; a doctor report that printed a plausible instant would be
 * read as a measurement.
 *
 * A real file-backed ledger, the real events, no mocks.
 *
 * Verifies: EPIC-14-S25 (the doctor line), EPIC-14-S27 (the honest wording) ·
 * AC10
 */
import type { Db } from '@DeFlow/core';
import { appendEvents, openLedger, readLatestRateLimits } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { rateLimitLines, renderRateLimitReport } from '../../src/providers/rate-limit-doctor.ts';

const T0 = 1_754_380_800_000;
const hours = (count: number): number => count * 3_600_000;
const RUN = 'run_20260805T090000Z_5c1d29';
const OTHER_RUN = 'run_20260805T090000Z_5c1d30';

const limited = (
  runId: string,
  provider: string,
  resetsAt: number | undefined,
  ts: number,
): Parameters<typeof appendEvents>[1][number] => ({
  runId,
  ts,
  kind: 'provider.rate_limited',
  v: 1,
  epoch: 1,
  payload: {
    provider,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    raw: { type: 'rate_limit_event' },
  },
});

const seed = (db: Db): void => {
  appendEvents(db, [
    limited(RUN, 'claude', T0 + hours(2), T0),
    limited(RUN, 'codex', undefined, T0 + 1_000),
    // A later limit for the same provider, in a *different run*. The report is
    // per provider and per machine, so this is the one that must win.
    limited(OTHER_RUN, 'claude', T0 + hours(6), T0 + 2_000),
  ]);
};

suite('AC10 — the latest limit per provider, across every run', () => {
  it('keeps one row per provider, the most recent by seq', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);
      expect(readLatestRateLimits(db)).toEqual([
        { provider: 'claude', resetsAt: T0 + hours(6), at: T0 + 2_000, runId: OTHER_RUN },
        { provider: 'codex', resetsAt: null, at: T0 + 1_000, runId: RUN },
      ]);
    } finally {
      db.close();
    }
  });

  it('answers empty on a ledger where nothing has been limited', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(readLatestRateLimits(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('AC10 — the section an operator reads', () => {
  it('names the reset instant when the vendor gave one', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);
      const lines = rateLimitLines({ limits: readLatestRateLimits(db), now: T0 + hours(1) });

      expect(lines[0]).toBe(
        `claude: rate limited until ${new Date(T0 + hours(6)).toISOString()} (5h 0m from now)`,
      );
    } finally {
      db.close();
    }
  });

  it('EPIC-14-S27: says the reset time is unknown rather than inventing one', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);
      const lines = rateLimitLines({ limits: readLatestRateLimits(db), now: T0 + hours(1) });

      expect(lines[1]).toBe('codex: rate limited, reset time unknown');
      // Nothing in that line may look like a time somebody could plan around.
      expect(lines[1]).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    } finally {
      db.close();
    }
  });

  it('says a limit has lapsed rather than printing a negative countdown', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);
      const lines = rateLimitLines({ limits: readLatestRateLimits(db), now: T0 + hours(9) });

      expect(lines[0]).toBe(
        `claude: was rate limited until ${new Date(T0 + hours(6)).toISOString()} (the reset has passed)`,
      );
    } finally {
      db.close();
    }
  });

  it('says so plainly when no provider has ever reported a limit', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(rateLimitLines({ limits: readLatestRateLimits(db), now: T0 })).toEqual([
        'no provider has reported a rate limit on this machine',
      ]);
    } finally {
      db.close();
    }
  });

  it('renders as a titled section, one claim per line', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);
      const report = renderRateLimitReport({
        limits: readLatestRateLimits(db),
        now: T0 + hours(1),
      });

      expect(report.split('\n')[0]).toBe('provider rate limits:');
      expect(report).toContain('  claude: rate limited until ');
      expect(report).toContain('  codex: rate limited, reset time unknown');
    } finally {
      db.close();
    }
  });
});
