/**
 * KAR-13.2 test plan #4, #5, #9 — `GET /api/approvals` over a real ledger.
 *
 * Integration rather than unit because the claim is about a **response body**
 * reached over a socket, served from a file-backed SQLite ledger holding two
 * concurrent runs. Folding events in-process and asserting on the projection
 * proves the projection; it does not prove that an Operator, or EPIC-17's queue
 * view, can see one call's worth of everything waiting on them.
 *
 * Verifies: EPIC-13-S10, EPIC-13-S15, EPIC-13-S16 · AC1, AC3, AC4, AC8, AC9
 */
import type { Db, RunId } from '@DeFlow/core';
import { approvalsProjection } from '@DeFlow/core';
import {
  openLedger,
  pendingPatchApprovals,
  readTaintedNodes,
  replayRun,
  writeCheckpoint,
} from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, waitFor } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import {
  EPOCH,
  GATE_NODE,
  PATCH_ID,
  PROMPT,
  QUEUE_RULE,
  RUN_A,
  RUN_B,
  seedApprovalRuns,
  T0,
} from './support/approval-queue-run.ts';

const HANG_SCRIPT = fileURLToPath(new URL('./support/hang-with-approvals.ts', import.meta.url));

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

/** A daemon-shaped HTTP server over a real ledger holding both runs. */
async function serve(dataDir: string): Promise<Served> {
  const db = openLedger(dataDir);
  seedApprovalRuns(db);

  const view = openLedgerView(dataDir);
  setLedgerView(view);
  setIntakePorts({
    db,
    epoch: EPOCH,
    // Time enters through the injected clock, so the ages below are a fact
    // rather than a range: `Date.now()` here would make them untestable.
    clock: { now: () => T0 + 60_000, setTimer: () => ({ cancel: () => {} }) },
    dataDir,
    randomHex: () => 'aa0001',
  });

  const started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: false });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    async close() {
      await started.close();
      clearLedgerView();
      clearIntakePorts();
      view.close();
      db.close();
    },
  };
}

interface QueueBody {
  readonly items: readonly {
    runId: string;
    kind: string;
    node: string | null;
    summary: string;
    seq: number;
    ts: number | null;
    ageMs: number | null;
  }[];
  readonly counts: Record<string, number>;
  readonly headSeq: number;
}

let served: Served | undefined;
const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
  await served?.close();
  served = undefined;
});

suite('EPIC-13-S10 — one call, every run (AC1, AC9)', () => {
  it('returns both runs’ pending decisions from a single request, oldest first', async ({
    tmp,
  }) => {
    served = await serve(tmp);

    const response = await fetch(`${served.origin}/api/approvals`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as QueueBody;
    expect(body.items.map((item) => [item.runId, item.kind])).toEqual([
      [RUN_B, 'budget'],
      [RUN_A, 'human-node'],
      [RUN_A, 'patch'],
    ]);

    // Ordered by the seq of the event that created each item, oldest first —
    // the item that has been blocking longest is the one costing the most.
    const seqs = body.items.map((item) => item.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
  });

  it('carries the run id, node, kind, summary, creating seq and an age on every row', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const body = (await (await fetch(`${served.origin}/api/approvals`)).json()) as QueueBody;

    for (const item of body.items) {
      expect(item.runId).toMatch(/^run_/);
      expect(item.summary.length).toBeGreaterThan(0);
      expect(item.seq).toBeGreaterThan(0);
      expect(item.ts).toBe(T0);
      // Sixty seconds on the injected clock, exactly.
      expect(item.ageMs).toBe(60_000);
    }
    expect(body.items.find((item) => item.kind === 'human-node')?.node).toBe(GATE_NODE);
  });

  it('exposes per-run counts beside the queue, so a badge needs no second query', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const body = (await (await fetch(`${served.origin}/api/approvals`)).json()) as QueueBody;
    expect(body.counts).toEqual({ [RUN_A]: 2, [RUN_B]: 1 });
    expect(body.headSeq).toBeGreaterThan(0);
  });

  it('has no per-run approvals endpoint to poll instead', async ({ tmp }) => {
    served = await serve(tmp);
    const perRun = await fetch(`${served.origin}/api/runs/${RUN_A}/approvals`);
    expect(perRun.status).toBe(404);
  });

  it('carries the patch estimate and the queueing rule, so no second request is needed', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const body = (await (await fetch(`${served.origin}/api/approvals`)).json()) as {
      items: readonly Record<string, unknown>[];
    };

    const patch = body.items.find((item) => item.kind === 'patch');
    expect(patch).toMatchObject({
      patchId: PATCH_ID,
      status: 'queued',
      rule: QUEUE_RULE,
      estimate: {
        costUsdDelta: 6.2,
        blastRadiusFiles: 140,
        maxPermission: 'worktree',
        replanDepth: 2,
      },
    });
    expect(Array.isArray(patch?.ops)).toBe(true);

    const gate = body.items.find((item) => item.kind === 'human-node');
    expect(gate).toMatchObject({ prompt: PROMPT, options: [{ id: 'yes' }, { id: 'no' }] });
  });
});

suite('EPIC-13-S15 — derived, not accumulated (AC3)', () => {
  /** The queue as a value, computed off `db` through whichever replay is asked for. */
  const queueOf = (db: Db, cached: boolean): unknown =>
    approvalsProjection(
      [RUN_A, RUN_B].map((runId: RunId) => ({
        runId,
        state: replayRun(db, runId, cached ? {} : { enabled: false }).state,
        patches: pendingPatchApprovals(db, runId),
        taints: readTaintedNodes(db, runId),
      })),
    );

  it('produces an identical queue from a deleted cache and a replay from seq 0', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedApprovalRuns(db);

      // A checkpoint exists and is trusted…
      for (const runId of [RUN_A, RUN_B]) {
        const replayed = replayRun(db, runId, { enabled: false });
        writeCheckpoint(db, { runId, state: replayed.state, lastSeq: replayed.report.lastSeq });
      }
      expect(replayRun(db, RUN_A).source).toBe('checkpoint');

      // …and throwing it away changes nothing at all. The cache is an
      // optimisation, free to be discarded and never to be believed.
      expect(JSON.stringify(queueOf(db, true), null, 2)).toMatchSnapshot();
      expect(queueOf(db, false)).toEqual(queueOf(db, true));
    } finally {
      db.close();
    }
  });

  it('ignores an event kind this build does not know rather than crash-looping', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedApprovalRuns(db);
      const before = queueOf(db, false);

      db.prepare(
        'INSERT INTO event (run_id, ts, kind, v, epoch, payload) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(RUN_A, T0, 'quantum.entangled', 1, EPOCH, JSON.stringify({ node: 'nowhere' }));

      expect(queueOf(db, false)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-13-S15 — the queue survives kill -9 (AC4)', () => {
  it('comes back with the same items, the same creating seqs, and no duplicates', async ({
    tmp,
  }) => {
    const readyFile = join(tmp, 'ready.json');
    const child = startCrashable({ script: HANG_SCRIPT, args: [tmp, readyFile] });
    alive.push(child);

    await waitFor(() => existsSync(readyFile), {
      describe: 'the child to seed both runs',
      timeoutMs: 20_000,
    });

    // No cleanup, no flush, no handlers.
    await child.sigkill();
    alive.splice(alive.indexOf(child), 1);

    served = await serveOver(tmp);
    const body = (await (await fetch(`${served.origin}/api/approvals`)).json()) as QueueBody;

    expect(body.items.map((item) => [item.runId, item.kind, item.seq])).toEqual(readBefore(tmp));
    // Exactly once each: a restart re-derives the queue, it does not re-ask.
    expect(new Set(body.items.map((item) => `${item.runId}/${item.kind}/${item.seq}`)).size).toBe(
      body.items.length,
    );
  });
});

/** The `[runId, kind, seq]` triples the child recorded before it was killed. */
function readBefore(tmp: string): unknown {
  return JSON.parse(readFileSync(join(tmp, 'ready.json'), 'utf8'));
}

/** The same server, over a directory somebody else's process already wrote. */
async function serveOver(dataDir: string): Promise<Served> {
  const db = openLedger(dataDir);
  const view = openLedgerView(dataDir);
  setLedgerView(view);
  setIntakePorts({
    db,
    epoch: EPOCH + 1,
    clock: { now: () => T0 + 60_000, setTimer: () => ({ cancel: () => {} }) },
    dataDir,
    randomHex: () => 'aa0001',
  });
  const started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: false });
  const address = started.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    async close() {
      await started.close();
      clearLedgerView();
      clearIntakePorts();
      view.close();
      db.close();
    },
  };
}

suite('EPIC-13-S16 — resolving an item takes it out of the queue (AC8)', () => {
  it('drops the answered gate on the next projection, with no second request to make it so', async ({
    tmp,
  }) => {
    served = await serve(tmp);

    const before = (await (await fetch(`${served.origin}/api/approvals`)).json()) as QueueBody;
    expect(before.items.some((item) => item.kind === 'human-node')).toBe(true);

    const answered = await fetch(`${served.origin}/api/runs/${RUN_A}/nodes/${GATE_NODE}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'yes' }),
    });
    expect(answered.status).toBe(200);
    expect((await answered.json()) as { effect: string }).toMatchObject({ effect: 'approve' });

    const after = (await (await fetch(`${served.origin}/api/approvals`)).json()) as QueueBody;
    expect(after.items.some((item) => item.kind === 'human-node')).toBe(false);
    expect(after.counts[RUN_A]).toBe(1);
  });

  it('answers a second response with 409 and the original decision', async ({ tmp }) => {
    served = await serve(tmp);
    const url = `${served.origin}/api/runs/${RUN_A}/nodes/${GATE_NODE}/respond`;
    const post = (optionId: string): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionId }),
      });

    expect((await post('yes')).status).toBe(200);

    const second = await post('no');
    expect(second.status).toBe(409);
    expect(
      (await second.json()) as { error: { code: string; detail: { response: unknown } } },
      // KAR-15.1's closed envelope: the code is the stable identifier, and the
      // decision that actually stands travels in `detail`.
    ).toMatchObject({
      error: { code: 'already_answered', detail: { response: { optionId: 'yes' } } },
    });

    // One decision on the log, whatever the second caller asked for.
    expect(respondedCount(served.db, RUN_A)).toBe(1);
  });
});

function respondedCount(db: Db, runId: RunId): number {
  const row = db
    .prepare<{ n: number }>(
      "SELECT COUNT(*) AS n FROM event WHERE run_id = ? AND kind = 'human.responded'",
    )
    .get(runId);
  return row?.n ?? 0;
}
