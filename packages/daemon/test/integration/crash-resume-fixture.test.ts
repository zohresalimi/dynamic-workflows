/**
 * KAR-15.4 test plan #6 — the `crash-resume-seq-gap` fixture, and resume across
 * the hole a real `kill -9` left in it.
 *
 * Verifies: EPIC-15-S29, EPIC-15-S30 (its cursor half) · AC5, AC6, AC8
 *
 * The fixture is an epic precondition (*"half the resume scenarios in this epic
 * are unwritable without it"*) and it is **produced by a real crash**, never
 * written by hand: a detached child appends two interleaved runs into one
 * file-backed ledger and is SIGKILLed while it is still writing. What survives
 * is what SQLite committed, and the run under test comes out with `seq` 4, 5, 7,
 * 8, 11 — a healthy, gappy sequence, because `6`, `9` and `10` belong to the
 * other run.
 *
 * That is the whole point of the corpus entry. A client that treats the hole as
 * a dropped event reports false data loss on a perfectly correct ledger and may
 * "repair" by refetching from zero, which on a multi-hour run is minutes of
 * wasted work triggered by nothing (docs/11-api-and-realtime.md §4.2).
 */
import type { RunId } from '@DeFlow/core';
import { openRead, readRange } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import {
  buildCrashResumeFixture,
  CRASH_RESUME_FIXTURE_DIR,
  CRASH_RESUME_OTHER_RUN,
  CRASH_RESUME_RUN,
  CRASH_RESUME_SEQS,
} from '../../scripts/build-crash-resume-fixture.ts';
import {
  fetch,
  helloOf,
  type OpenStream,
  openStream,
  type Served,
  serve,
} from './support/stream-daemon.ts';

const FIXTURE_DB = join(CRASH_RESUME_FIXTURE_DIR, 'ledger.db');

let served: Served | undefined;
const opened: OpenStream[] = [];

afterEach(async () => {
  for (const stream of opened.splice(0)) stream.close();
  await served?.close();
  served = undefined;
});

/**
 * The fixture, copied into a tmpdir before anything opens it.
 *
 * Never served in place: opening a SQLite file creates `-wal` and `-shm` beside
 * it, and the retention spec below deletes a row. A committed fixture that a
 * test run can mutate is a fixture that stops meaning what its README says.
 */
const servedCopy = (tmp: string): string => {
  copyFileSync(FIXTURE_DB, join(tmp, 'ledger.db'));
  return tmp;
};

const seqsOf = (dir: string, runId: RunId): number[] => {
  const db = openRead(join(dir, 'ledger.db'));
  try {
    return readRange(db, runId, 0, 1000).events.map((event) => event.seq);
  } finally {
    db.close();
  }
};

suite('EPIC-15-S29 — the committed fixture really has a gap (AC5)', () => {
  it('is there, and holds 4, 5, 7, 8, 11 for the run under test', () => {
    expect(existsSync(FIXTURE_DB)).toBe(true);
    expect(seqsOf(CRASH_RESUME_FIXTURE_DIR, CRASH_RESUME_RUN)).toEqual(CRASH_RESUME_SEQS);
  });

  it('accounts for the missing numbers: they belong to the other run', () => {
    const other = seqsOf(CRASH_RESUME_FIXTURE_DIR, CRASH_RESUME_OTHER_RUN);
    // 6, 9 and 10 are not lost. They are somebody else's, which is exactly why
    // gap detection reports a loss that never happened.
    expect(other).toEqual(expect.arrayContaining([6, 9, 10]));
    expect(other).not.toEqual(expect.arrayContaining(CRASH_RESUME_SEQS));
  });

  it('rebuilds from a real kill -9 to the same sequence — the drift check', async ({ tmp }) => {
    const built = await buildCrashResumeFixture(join(tmp, 'out'), join(tmp, 'work'));

    expect(built.killed.signal).toBe('SIGKILL');
    expect(seqsOf(built.outDir, CRASH_RESUME_RUN)).toEqual(CRASH_RESUME_SEQS);
    // The ledger a SIGKILL left behind is a ledger SQLite can still vouch for.
    expect(built.integrity).toBe('ok');
  });
});

suite('EPIC-15-S29 / AC8 — resuming across the crash, from a persisted cursor', () => {
  it('streams 7, 8, 11 for a client that had applied up to 5', async ({ tmp }) => {
    served = await serve(servedCopy(tmp));

    const stream = await openStream(served.origin, `runs=${CRASH_RESUME_RUN}&since=5`);
    opened.push(stream);
    await helloOf(stream.frames);
    await stream.frames.until((frame) => frame.event === 'caught_up');

    const delivered = stream.frames
      .all()
      .filter((frame) => frame.event === undefined)
      .map((frame) => (JSON.parse(frame.data) as { seq: number }).seq);

    // Every event committed before the crash, and the hole crossed in silence:
    // no `fatal` frame, no warning, nothing that says a number is missing.
    expect(delivered).toEqual([7, 8, 11]);
    expect(stream.frames.all().some((frame) => frame.event === 'fatal')).toBe(false);
    expect(stream.frames.raw()).not.toMatch(/missing|gap|data loss/i);
  });

  it('hydrates the whole run in one page, gap included', async ({ tmp }) => {
    served = await serve(servedCopy(tmp));

    const response = await fetch(`${served.origin}/api/runs/${CRASH_RESUME_RUN}/events?since=0`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      events: { seq: number }[];
      cursor: number;
      headSeq: number;
      more: boolean;
    };

    expect(page.events.map((event) => event.seq)).toEqual(CRASH_RESUME_SEQS);
    expect(page.more).toBe(false);
    expect(page.cursor).toBe(11);
    // The denominator is this run's head, which is the last event it committed
    // before the crash — not the directory's, which the other run moved past it.
    expect(page.headSeq).toBe(11);
  });
});

suite('EPIC-15-S30 — a persisted cursor survives a delete and an append (AC6)', () => {
  it('serves the new event to a client resuming from the deleted row’s seq', async ({ tmp }) => {
    served = await serve(servedCopy(tmp));
    const top = 11;

    // Retention, spelled out: the row a client's cursor names is pruned, and a
    // new event is appended after it. `AUTOINCREMENT` is what stops the new one
    // from being handed 11 back — and a cursor at 11 from silently naming it.
    served.db.prepare('DELETE FROM event WHERE seq = ?').run(top);
    const appended = served.db
      .prepare<{ seq: number }>(
        'INSERT INTO event (run_id, ts, kind, v, epoch, payload) ' +
          "VALUES (?, 1754308400000, 'node.progress', 1, 5, ?) RETURNING seq",
      )
      .get(
        CRASH_RESUME_RUN,
        JSON.stringify({ node: 'impl', attempt: 1, phase: 'running', message: 'after retention' }),
      );

    expect(appended?.seq).toBeGreaterThan(top);

    const response = await fetch(
      `${served.origin}/api/runs/${CRASH_RESUME_RUN}/events?since=${top}`,
    );
    const page = (await response.json()) as { events: { seq: number }[] };
    expect(page.events.map((event) => event.seq)).toEqual([appended?.seq]);
  });
});
