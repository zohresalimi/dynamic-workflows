/**
 * KAR-27.3 AC1 — `deflow status` on a run whose framing turn is in flight.
 *
 * The daemon half of this criterion is
 * `packages/daemon/test/integration/framing-liveness-status.test.ts`. This is
 * the other surface AC1 names by name, and it is asserted here rather than
 * inferred from a shared function because the operator's actual complaint on
 * 2026-08-23 was about a *rendered* sentence: the label has to reach stdout,
 * not merely exist in a projection.
 *
 * A real file-backed ledger and a real `daemon.json` describing this process,
 * because `readStatus` reports no runs for a daemon record it cannot verify.
 *
 * Verifies: EPIC-27-S15, EPIC-27-S16 · KAR-27.3 AC1
 */
import { processStartTime } from '@DeFlow/adapters';
import type { Db, RunId } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { readStatus, runStatus } from '../../src/status.ts';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

const RUN = 'run_20260823T104141Z_e9eac2' as RunId;
const TS = 1_787_000_000_000;
const OPENED_AT = TS + 5_000;

/** A run that has been submitted and whose framing child is running. */
function seed(db: Db, extra: readonly EventDraft[] = []): void {
  appendEvents(db, [
    {
      runId: RUN,
      ts: TS,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        sha256: 'a'.repeat(64),
        raw: 'Make a run that is framing look alive',
        provenance: { kind: 'text', by: 'cli', submittedAt: TS },
      },
    } as EventDraft,
    {
      runId: RUN,
      ts: OPENED_AT,
      kind: 'provider.session_opened',
      v: 1,
      epoch: 1,
      nodeId: 'framing',
      attempt: 0,
      payload: {
        node: 'framing',
        attempt: 0,
        provider: 'claude',
        session: { id: '9d1f0f2a-0000-4000-8000-000000000000', origin: 'minted' },
      },
    } as EventDraft,
    ...extra,
  ]);
}

/** A `daemon.json` describing *this* process, so the record verifies. */
function daemonRecord(dataDir: string): void {
  writeFileSync(
    join(dataDir, 'daemon.json'),
    JSON.stringify({
      pid: process.pid,
      port: 7777,
      token: 'not-a-real-token',
      startedAt: TS,
      processStartedAt: processStartTime(process.pid),
      tickIntervalMs: 1_000,
    }),
  );
}

function seeded(extra: readonly EventDraft[] = []): string {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = openLedger(dataDir);
  try {
    seed(db, extra);
  } finally {
    db.close();
  }
  daemonRecord(dataDir);
  return dataDir;
}

suite('EPIC-27-S15 — deflow status names the turn that is running (AC1)', () => {
  it('prints the node, the attempt and the since-instant rather than "waiting"', () => {
    const dataDir = seeded();

    const status = readStatus({ env: { DeFlow_DATA_DIR: dataDir } });
    expect(status.kind).toBe('running');
    if (status.kind !== 'running') return;

    const expected = `framing — running · attempt 1 of 3 · since ${new Date(OPENED_AT).toISOString()}`;
    expect(status.runs.find((row) => row.runId === RUN)?.label).toBe(expected);

    // The report wraps a long value across the column, so the sentence is
    // asserted in the pieces the renderer keeps intact rather than verbatim —
    // the whole string is pinned above, on the value the renderer was handed.
    const report = runStatus({ env: { DeFlow_DATA_DIR: dataDir } }).stdout;
    expect(report).toContain('framing — running · attempt 1 of 3');
    expect(report).toContain(new Date(OPENED_AT).toISOString());
    expect(report).not.toContain('waiting to be framed');
  });

  it('goes back to "waiting to be framed" once the attempt concluded (EPIC-27-S16)', () => {
    const dataDir = seeded([
      {
        runId: RUN,
        ts: OPENED_AT + 1_000,
        kind: 'node.failed',
        v: 1,
        epoch: 1,
        nodeId: 'framing',
        attempt: 0,
        payload: {
          node: 'framing',
          attempt: 0,
          maxAttempts: 3,
          failure: {
            reason: 'agent.nonzero-exit',
            class: 'transient',
            message: 'claude exited 1 without completing the turn',
            occurredAtEvent: 1,
            attempt: 0,
            evidence: [],
          },
        },
      } as EventDraft,
    ]);

    const status = readStatus({ env: { DeFlow_DATA_DIR: dataDir } });
    if (status.kind !== 'running') throw new Error('the seeded daemon record did not verify');

    expect(status.runs.find((row) => row.runId === RUN)?.label).toBe(
      'submitted — waiting to be framed',
    );
  });
});
