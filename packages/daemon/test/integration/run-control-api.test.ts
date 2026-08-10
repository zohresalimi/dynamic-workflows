/**
 * KAR-15.5 — the three control verbs over a real HTTP server and a real
 * file-backed ledger.
 *
 * Integration rather than unit because every claim is about a **response** —
 * status code, body, and what the log says afterwards — and a route can wire a
 * correct decision to the wrong status code. The transitions themselves are
 * asserted purely in `../../src/run-control.test.ts`; what is here is the wire.
 *
 * The `ifLastSeq` matrix needs a real second write landing between the render
 * and the decision, which is exactly what a file-backed ledger with a second
 * append gives and what no in-memory fixture can.
 *
 * Verifies: EPIC-15-S33, EPIC-15-S34, EPIC-15-S37 · AC1, AC2, AC3, AC4, AC6,
 * AC9
 */
import type { Db, RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import { CANCEL_RUN, draft, seedRunningRun, T0 } from './support/cancel-run.ts';

const fetch = authorizedFetch();

const RUN_A: RunId = RunIdSchema.parse(CANCEL_RUN);
/** A run intake created and framing has not finished: `task.submitted`, alone. */
const UNAPPROVED: RunId = RunIdSchema.parse('run_20260810T101500Z_bb0002');

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

/** A daemon-shaped HTTP server over a real ledger holding both runs. */
async function serve(dataDir: string): Promise<Served> {
  const db = openLedger(dataDir);
  seedRunningRun(db);
  appendEvents(db, [
    {
      runId: UNAPPROVED,
      ts: T0,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        input: { kind: 'text', text: 'Migrate the design system across packages/ui' },
        cwd: '/work/voyado-web',
        permission: 'worktree',
        provenance: { by: 'ui', at: '2026-08-10T10:15:00.000Z' },
      },
    },
  ]);

  const view = openLedgerView(dataDir);
  setLedgerView(view);
  setIntakePorts({
    db,
    epoch: 1,
    // Time enters through the injected clock, so an appended `ts` is a fact
    // rather than "roughly now".
    clock: {
      now: () => T0 + 5_000,
      sleep: () => Promise.resolve(),
      setTimer: () => ({ cancel: () => {} }),
    },
    dataDir,
    randomHex: () => 'aa0001',
  });

  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
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

interface ControlBody {
  readonly runId: string;
  readonly seq: number;
  readonly status: string;
  readonly appended: boolean;
  readonly kill?: { readonly outcome: string; readonly survivors: readonly unknown[] };
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: Record<string, unknown>;
    readonly retryable: boolean;
    readonly seq?: number;
  };
}

const post = (origin: string, path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Every event kind this run holds, in `seq` order. */
const kindsOf = (db: Db, runId: string): string[] =>
  db
    .prepare<{ kind: string }>('SELECT kind FROM event WHERE run_id = ? ORDER BY seq')
    .all(runId)
    .map((row) => row.kind);

const countOf = (db: Db, runId: string, kind: string): number =>
  kindsOf(db, runId).filter((one) => one === kind).length;

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('EPIC-15-S33 — the three control verbs (AC1)', () => {
  it('pauses, resumes and cancels, appending each event and echoing its seq', async ({ tmp }) => {
    served = await serve(tmp);
    const { origin, db } = served;

    const paused = await post(origin, `/api/runs/${RUN_A}/pause`);
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as ControlBody;
    expect(pausedBody).toMatchObject({ runId: RUN_A, status: 'paused', appended: true });

    const resumed = await post(origin, `/api/runs/${RUN_A}/resume`);
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as ControlBody;
    expect(resumedBody).toMatchObject({ status: 'running', appended: true });
    expect(resumedBody.seq).toBeGreaterThan(pausedBody.seq);

    const cancelled = await post(origin, `/api/runs/${RUN_A}/cancel`, { mode: 'cooperative' });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()) as ControlBody).toMatchObject({
      status: 'cancelling',
      appended: true,
    });

    // Each seq is the seq of the event the ledger actually holds.
    expect(kindsOf(db, RUN_A).slice(-3)).toEqual([
      'run.paused',
      'run.resumed',
      'run.cancel.requested',
    ]);
    const payload = db
      .prepare<{ payload: string }>(
        `SELECT payload FROM event WHERE run_id = ? AND kind = 'run.cancel.requested'`,
      )
      .get(RUN_A)?.payload;
    expect(JSON.parse(payload ?? '{}')).toEqual({ mode: 'cooperative' });
  });

  it('stamps the appended event with the injected clock, never the wall clock', async ({ tmp }) => {
    served = await serve(tmp);
    await post(served.origin, `/api/runs/${RUN_A}/pause`);

    const ts = served.db
      .prepare<{ ts: number }>(`SELECT ts FROM event WHERE run_id = ? AND kind = 'run.paused'`)
      .get(RUN_A)?.ts;
    expect(ts).toBe(T0 + 5_000);
  });

  it('refuses a cancel whose mode is not one of the two ladders', async ({ tmp }) => {
    served = await serve(tmp);
    const response = await post(served.origin, `/api/runs/${RUN_A}/cancel`, { mode: 'politely' });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.detail.field).toBe('mode');
    expect(countOf(served.db, RUN_A, 'run.cancel.requested')).toBe(0);
  });
});

suite('EPIC-15-S33 — repeating a write is a no-op, not an error (AC2)', () => {
  it('answers a second pause with 200 and the existing seq, appending nothing', async ({ tmp }) => {
    served = await serve(tmp);
    const { origin, db } = served;

    const first = (await (await post(origin, `/api/runs/${RUN_A}/pause`)).json()) as ControlBody;
    const second = await post(origin, `/api/runs/${RUN_A}/pause`);

    expect(second.status).toBe(200);
    const body = (await second.json()) as ControlBody;
    expect(body.seq).toBe(first.seq);
    expect(body.appended).toBe(false);
    expect(countOf(db, RUN_A, 'run.paused')).toBe(1);
  });

  it('answers a resume of a run that is already running the same way', async ({ tmp }) => {
    served = await serve(tmp);
    const response = await post(served.origin, `/api/runs/${RUN_A}/resume`);

    expect(response.status).toBe(200);
    expect((await response.json()) as ControlBody).toMatchObject({ appended: false });
    expect(countOf(served.db, RUN_A, 'run.resumed')).toBe(0);
  });

  it('answers a repeated cancel with the seq of the request already in flight', async ({ tmp }) => {
    served = await serve(tmp);
    const { origin, db } = served;

    const first = (await (
      await post(origin, `/api/runs/${RUN_A}/cancel`, { mode: 'cooperative' })
    ).json()) as ControlBody;
    const second = (await (
      await post(origin, `/api/runs/${RUN_A}/cancel`, { mode: 'cooperative' })
    ).json()) as ControlBody;

    expect(second.seq).toBe(first.seq);
    expect(second.appended).toBe(false);
    expect(countOf(db, RUN_A, 'run.cancel.requested')).toBe(1);
  });
});

suite('EPIC-15-S33 — a run that genuinely cannot pause (AC2, AC9)', () => {
  it('answers 409 run_not_pausable in the closed error envelope', async ({ tmp }) => {
    served = await serve(tmp);
    appendEvents(served.db, [
      draft('run.completed', { outcome: 'succeeded', criteriaSatisfied: [] }),
    ]);

    const response = await post(served.origin, `/api/runs/${RUN_A}/pause`);

    expect(response.status).toBe(409);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('run_not_pausable');
    expect(body.error.retryable).toBe(false);
    expect(body.error.detail).toMatchObject({ status: 'completed' });
    expect(countOf(served.db, RUN_A, 'run.paused')).toBe(0);
  });

  it('answers 404 run_not_found for a run this ledger does not hold', async ({ tmp }) => {
    served = await serve(tmp);
    const response = await post(served.origin, '/api/runs/run_20260810T101500Z_ffffff/pause');

    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorBody).error.code).toBe('run_not_found');
  });
});

suite('EPIC-15-S37 — creating a run does not start it (AC6)', () => {
  it('refuses every control verb with 422 spec_not_approved before approval', async ({ tmp }) => {
    served = await serve(tmp);

    for (const [path, body] of [
      ['pause', {}],
      ['resume', {}],
      ['cancel', { mode: 'cooperative' }],
    ] as const) {
      const response = await post(served.origin, `/api/runs/${UNAPPROVED}/${path}`, body);
      expect(response.status).toBe(422);
      expect(((await response.json()) as ErrorBody).error.code).toBe('spec_not_approved');
    }

    // Nothing was appended by any of the three.
    expect(kindsOf(served.db, UNAPPROVED)).toEqual(['task.submitted']);
  });

  it('holds only task.submitted for a run intake created — no node was scheduled', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    expect(kindsOf(served.db, UNAPPROVED)).toEqual(['task.submitted']);
    expect(kindsOf(served.db, UNAPPROVED)).not.toContain('node.scheduled');
    expect(kindsOf(served.db, UNAPPROVED)).not.toContain('run.created');
  });
});

suite('EPIC-15-S34 — ifLastSeq and the stale panel (AC3)', () => {
  it('refuses with 409 stale_cursor carrying the head when the surface moved', async ({ tmp }) => {
    served = await serve(tmp);
    const { origin, db } = served;

    const cursor = db.prepare<{ head: number }>('SELECT max(seq) AS head FROM event').get()
      ?.head as number;
    // The patch policy timer, applying something while the panel was open.
    appendEvents(db, [
      draft('plan.patch.queued', {
        patchId: 'patch-somebody-else',
        rule: 'escalates-permission',
        estimate: {
          costUsdDelta: 6.2,
          blastRadiusFiles: 140,
          maxPermission: 'worktree',
          replanDepth: 2,
        },
      }),
    ]);

    const response = await post(origin, `/api/runs/${RUN_A}/pause`, { ifLastSeq: cursor });

    expect(response.status).toBe(409);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('stale_cursor');
    expect(body.error.detail.movedAt).toBe(cursor + 1);
    expect(body.error.detail.head).toBe(cursor + 1);
    expect(countOf(db, RUN_A, 'run.paused')).toBe(0);
  });

  it('succeeds when the head advanced only by progress frames', async ({ tmp }) => {
    served = await serve(tmp);
    const { origin, db } = served;

    const cursor = db.prepare<{ head: number }>('SELECT max(seq) AS head FROM event').get()
      ?.head as number;
    appendEvents(
      db,
      Array.from({ length: 20 }, (_, index) =>
        draft(
          'node.progress',
          { node: 'impl-auth', attempt: 0, phase: 'running', message: `working ${index}` },
          { nodeId: 'impl-auth', attempt: 0 },
        ),
      ),
    );

    const response = await post(origin, `/api/runs/${RUN_A}/pause`, { ifLastSeq: cursor });

    expect(response.status).toBe(200);
    expect((await response.json()) as ControlBody).toMatchObject({ appended: true });
  });
});

suite('EPIC-15-S34 — deciding a patch twice (AC4)', () => {
  it('answers 409 patch_already_decided with the original decision and who made it', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const { origin, db } = served;

    const patchId = 'patch-already-answered';
    appendEvents(db, [
      draft('plan.patch.rejected', {
        patchId,
        reason: 'the operator said no',
        by: 'human',
        rule: 'rejected-by-operator',
      }),
    ]);

    const response = await fetch(`${origin}/api/runs/${RUN_A}/patches/${patchId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('patch_already_decided');
    expect(body.error.detail.decision).toMatchObject({ decision: 'rejected', by: 'human' });
    expect(countOf(db, RUN_A, 'plan.patched')).toBe(0);
  });
});
