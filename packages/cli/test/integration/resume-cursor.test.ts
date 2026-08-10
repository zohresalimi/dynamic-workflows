/**
 * KAR-15.4 AC9 — `DeFlow` resumes through the identical code path as the UI,
 * with no `Last-Event-ID` mechanism at all.
 *
 * Verifies: EPIC-15-S27 (its CLI half), EPIC-15-S29, EPIC-15-S31 · AC4, AC5,
 * AC9
 *
 * The CLI has no browser behind it: nothing anywhere in a terminal maintains a
 * `Last-Event-ID`, so `?since=` is not one of two options for it, it is the
 * only one. That is precisely why the server's precedence puts the query
 * parameter first (docs/11-api-and-realtime.md §4.1) — and why the *same*
 * `hydrateRun` and `connectStream` the UI uses are what these commands are
 * built from, rather than a second implementation that would drift.
 *
 * Over a real socket against a real ledger, because the claim is about two
 * halves meeting: the endpoint's paging and the client's loop.
 */
import type { RunId } from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { followRun, resumeRun } from '../../src/index.ts';
import { EPOCH, type ServedDaemon, serveDaemon, T0 } from './support/daemon.ts';

/** The fixture a real `kill -9` produced — see the daemon's build script. */
const FIXTURE_DB = fileURLToPath(
  new URL('../../../../test/fixtures/runs/crash-resume-seq-gap/ledger.db', import.meta.url),
);
const FIXTURE_RUN = 'run_20260810T101500Z_c4a5b1' as RunId;
const FIXTURE_SEQS = [4, 5, 7, 8, 11];

let served: ServedDaemon | undefined;
const stop: (() => void)[] = [];

afterEach(async () => {
  for (const closer of stop.splice(0)) closer();
  await served?.close();
  served = undefined;
});

async function serveFixture(tmp: string): Promise<ServedDaemon> {
  // Copied, never opened in place: a spec that mutated the committed fixture
  // would leave the next reader a different fixture than its README describes.
  copyFileSync(FIXTURE_DB, join(tmp, 'ledger.db'));
  served = await serveDaemon(tmp);
  return served;
}

const daemon = (): { baseUrl: string; token: string } => ({
  baseUrl: served?.baseUrl ?? '',
  token: TEST_DAEMON_TOKEN,
});

const progress = (message: string): EventDraft =>
  ({
    runId: FIXTURE_RUN,
    ts: T0,
    kind: 'node.progress',
    v: 1,
    epoch: EPOCH,
    payload: { node: 'impl', attempt: 1, phase: 'running', message },
  }) as EventDraft;

suite('EPIC-15-S31 — the CLI hydrates through ?since= alone (AC4, AC9)', () => {
  it('applies every event of a crashed run, gap and all', async ({ tmp }) => {
    await serveFixture(tmp);
    const applied: number[] = [];

    const result = await resumeRun(FIXTURE_RUN, {
      ...daemon(),
      onEvent: (e) => applied.push(e.seq),
    });

    expect(applied).toEqual(FIXTURE_SEQS);
    expect(result.cursor).toBe(11);
    expect(result.headSeq).toBe(11);
    expect(result.applied).toBe(5);
    expect(result.pages).toBe(1);
  });

  it('resumes from a cursor the operator’s last run left behind', async ({ tmp }) => {
    await serveFixture(tmp);
    const applied: number[] = [];

    const result = await resumeRun(FIXTURE_RUN, {
      ...daemon(),
      since: 5,
      onEvent: (event) => applied.push(event.seq),
    });

    // 7, 8, 11 — the crash-produced hole between 5 and 7 crossed without a
    // word, because it is not a hole in this run's history at all.
    expect(applied).toEqual([7, 8, 11]);
    expect(result.cursor).toBe(11);
  });

  it('pages when the run is longer than one window', async ({ tmp }) => {
    await serveFixture(tmp);
    const applied: number[] = [];

    const result = await resumeRun(FIXTURE_RUN, {
      ...daemon(),
      limit: 2,
      onEvent: (event) => applied.push(event.seq),
    });

    expect(applied).toEqual(FIXTURE_SEQS);
    expect(result.pages).toBe(3);
  });

  it('refuses a run the daemon does not hold, rather than looping', async ({ tmp }) => {
    await serveFixture(tmp);
    await expect(
      resumeRun('run_20260810T101500Z_ffffff' as RunId, { ...daemon(), onEvent: () => undefined }),
    ).rejects.toThrow(/404/);
  });
});

suite('EPIC-15-S27 — hydrate, then follow from the cursor it returned (AC9)', () => {
  it('sees events committed after the hydrate, each exactly once', async ({ tmp }) => {
    await serveFixture(tmp);
    const applied: number[] = [];

    const following = await followRun(FIXTURE_RUN, {
      ...daemon(),
      onEvent: (event) => applied.push(event.seq),
    });
    stop.push(() => following.close());

    expect(following.cursor).toBe(11);
    expect(applied).toEqual(FIXTURE_SEQS);

    const live = appendEvents(served?.db as never, [progress('after the resume')]);
    await expect
      .poll(() => applied.length, { timeout: 5000 })
      .toBe(FIXTURE_SEQS.length + live.length);

    expect(applied).toEqual([...FIXTURE_SEQS, ...live]);
    expect(new Set(applied).size).toBe(applied.length);
  });
});
