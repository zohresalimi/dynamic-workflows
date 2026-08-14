/**
 * KAR-19.12 AC5 — `deflow status` names the gate a run is waiting on.
 *
 * The case that matters is deliberately **not** the F1.3 spec gate: that one
 * has a run status of its own, so `status` half-answers it already. A blocking
 * `human` plan node opens its gate while `state.status` is still `running` — so
 * the command an operator types to find out why nothing is happening answers
 * *"running"*, which is true, useless, and exactly the sentence that sent them
 * to read the ledger on 2026-08-14.
 *
 * A real file-backed ledger through the shipped append boundary, and a real
 * `daemon.json` describing this process, because `readStatus` refuses to report
 * runs for a daemon record it cannot verify — asserting on a hand-built
 * `RunningStatus` would skip the derivation this criterion is about.
 *
 * Verifies: EPIC-19-S82 · KAR-19.12 AC5 · test plan #7
 */
import { processStartTime } from '@DeFlow/adapters';
import type { Db, RunId } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { readStatus, renderStatusJson, runStatus } from '../../src/status.ts';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

const RUN = 'run_20260814T013434Z_c984dd' as RunId;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const TS = 1_786_670_000_000;

const GATE_NODE = 'approve-scope';

/** A run that is executing and has stopped on a blocking `human` node. */
function seed(db: Db): void {
  const drafts: EventDraft[] = [
    {
      runId: RUN,
      ts: TS,
      kind: 'run.spec.approved',
      v: 1,
      epoch: 1,
      payload: {
        specHash: SPEC_HASH,
        by: 'cli',
      },
    },
    { runId: RUN, ts: TS, kind: 'run.started', v: 1, epoch: 1, payload: { planHash: PLAN_HASH } },
    {
      runId: RUN,
      ts: TS,
      kind: 'human.requested',
      v: 5,
      epoch: 1,
      nodeId: GATE_NODE,
      payload: {
        node: GATE_NODE,
        prompt: 'Recon found 3 extra packages. Extend the migration scope?',
        options: [
          { id: 'yes', label: 'Extend scope', effect: 'approve' },
          { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
        ],
      },
    },
  ];
  appendEvents(db, drafts);
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

suite('EPIC-19-S82 — status names the gate, not just the status word (AC5)', () => {
  it('reports the gate node and its options for a run whose status is still running', () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    try {
      seed(db);
    } finally {
      db.close();
    }
    daemonRecord(dataDir);

    const status = readStatus({ env: { DeFlow_DATA_DIR: dataDir } });
    expect(status.kind).toBe('running');
    if (status.kind !== 'running') return;

    const run = status.runs.find((candidate) => candidate.runId === RUN);
    // KAR-19.1 AC6 — the status word is unchanged and still `runStatusLabel`'s.
    expect(run?.label).toBe('running');
    // AC5 — and the gate is named beside it, which is the fact `running` cannot
    // carry.
    expect(run?.gate?.node).toBe(GATE_NODE);
    expect(run?.gate?.options.map((option) => option.id)).toEqual(['yes', 'no']);

    const report = runStatus({ env: { DeFlow_DATA_DIR: dataDir } }).stdout;
    expect(report).toContain(GATE_NODE);
    expect(report).toContain('yes');

    const json = JSON.parse(renderStatusJson(status)) as {
      runs: readonly { runId: string; gate: { node: string } | null }[];
    };
    expect(json.runs.find((row) => row.runId === RUN)?.gate?.node).toBe(GATE_NODE);
  });
});
