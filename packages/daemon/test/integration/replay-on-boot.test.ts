/**
 * KAR-03.8 — DeFlowd rebuilds every run from the ledger at boot, and serves
 * (EPIC-03-S16 scenario 1, AC1 and AC4).
 *
 * The ledger half of downgrade tolerance is proved next door in
 * `@DeFlow/ledger`. This is the half that only a real daemon can answer: given
 * a data directory written by a *newer* binary, does the process start, bind
 * its port and serve the run — or does it die and come back and die again?
 *
 * A real port, a real tmp data directory, a real file-backed ledger. `dev:
 * false` throughout, because Vite has nothing to do with replay and costs
 * seconds to start.
 *
 * Verifies: EPIC-03-S16 (scenarios 1 and 3) · AC1, AC4
 */
import { appendEvents, type EventDraft, openLedger } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { createServer } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';
const PLAN_HASH = `sha256-${'c'.repeat(64)}`;
const START_TS = 1_754_308_293_000;

/** The kind this binary has never heard of, written by the newer one. */
const FUTURE_KIND = 'node.sandbox.escalated';
const NODES = 12;

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** A run as a newer DeFlowd left it: known lifecycle events, plus 12 it invented. */
function seedNewerLedger(dataDir: string): number {
  const drafts: EventDraft[] = [];
  const push = (kind: string, payload: unknown): void => {
    drafts.push({
      runId: RUN as never,
      ts: START_TS + drafts.length * 1000,
      kind,
      v: 1,
      epoch: 1,
      payload,
    });
  };

  push('run.started', { planHash: PLAN_HASH });
  for (let index = 0; index < NODES; index += 1) {
    const node = `step-${String(index + 1).padStart(2, '0')}`;
    push('node.scheduled', { node, provider: 'claude-code', permission: 'worktree' });
    push('node.started', {
      node,
      attempt: 0,
      ikey: `${RUN}/${node}/0/0`,
      binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: 'd'.repeat(64) },
    });
    push(FUTURE_KIND, { node, attempt: 0, sandbox: 'seatbelt', reason: 'network' });
    push('node.completed', {
      node,
      attempt: 0,
      result: {
        status: 'completed',
        output: { summary: `${node} done` },
        outputSchemaId: 'DeFlow.artifact.v1',
        usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
        costUsd: 0.25,
        producedFacts: [],
        artifacts: [],
      },
    });
  }

  const db = openLedger(dataDir);
  try {
    const seqs = appendEvents(db, drafts);
    return seqs.at(-1) ?? 0;
  } finally {
    db.close();
  }
}

suite('DeFlowd starts over a ledger written by a newer binary (EPIC-03-S16)', () => {
  it('does not throw, binds its port, and serves the run it rebuilt', async ({ tmp }) => {
    const head = seedNewerLedger(tmp);
    const port = await freePort();

    booted = await boot({ dataDir: tmp, port, dev: false });

    const state = booted.runs.get(RUN as never);
    expect(state?.status).toBe('running');
    expect(Object.keys(state?.nodes ?? {})).toHaveLength(NODES);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ headSeq: head, daemonEpoch: booted.epoch });
  });

  it('reports the skipped kinds once, as a count rather than as a failure', async ({ tmp }) => {
    seedNewerLedger(tmp);
    booted = await boot({ dataDir: tmp, port: await freePort(), dev: false });

    const replay = booted.replays[0];
    expect(replay?.report.skippedByKind).toEqual({ [FUTURE_KIND]: NODES });
    expect(replay?.report.unreadable).toEqual([]);
  });

  it('does not enter a crash loop — the second start is the one that matters', async ({ tmp }) => {
    seedNewerLedger(tmp);
    const port = await freePort();

    const first = await boot({ dataDir: tmp, port, dev: false });
    const firstState = first.runs.get(RUN as never);
    await first.shutdown();

    booted = await boot({ dataDir: tmp, port, dev: false });
    expect(booted.runs.get(RUN as never)).toEqual(firstState);
  });
});

suite('an empty data directory boots to an empty map', () => {
  it('serves a head seq of 0 rather than refusing to start', async ({ tmp }) => {
    const port = await freePort();
    booted = await boot({ dataDir: tmp, port, dev: false });

    expect(booted.runs.size).toBe(0);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await health.json()).toMatchObject({ headSeq: 0 });
  });
});
