/**
 * KAR-19.6 test plan #3, #4, #5, #9 — stopping a run that never started, over
 * the route an operator's command actually posts to.
 *
 * Integration rather than unit because every claim here is about **what the
 * ledger holds afterwards**: which events, at which `seq`, in how many commits,
 * and with which `node_wake` rows gone. The transitions themselves are pure and
 * are asserted in `../../src/run-control.test.ts`; what is here is the write.
 *
 * The commit count is the assertion that matters and it is not decoration.
 * `run.cancel.requested` and `run.aborted` appended separately would leave a
 * crash window in which the run is parked at `cancelling` with nothing in
 * flight to finish the ladder — the reported defect wearing a new name — and
 * consecutive `seq` values alone cannot tell that apart from two appends that
 * happened to be quick. `onCommitted` fires once per outermost transaction, so
 * counting it is the difference.
 *
 * Verifies: EPIC-19-S39, EPIC-19-S40, EPIC-19-S41 · KAR-19.6 AC3, AC4, AC5,
 * AC6, AC7
 */
import type { Db, RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import {
  appendEvents,
  headSeq,
  onCommitted,
  openLedger,
  readWakes,
  scheduleWake,
} from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import { FRAMING_NODE } from '../../src/spec/gate.ts';
import { SPEC_RUN, seedSpecGateRun } from './support/spec-gate-run.ts';

const fetch = authorizedFetch();

/** The instant every ledger in this file is anchored to. */
const T0 = 1_755_000_000_000;

/**
 * The three runs of 2026-08-12, by their exact ledger shapes (AC9).
 *
 * Two of them hold `task.submitted` then `provider.probed` and one holds
 * `task.submitted` alone, and the ids are the operator's own — a fixture that
 * renamed them would be a fixture about a different report.
 */
const REPORTED = [
  { runId: 'run_20260812T133401Z_318740', probed: true },
  { runId: 'run_20260812T133514Z_ed4f12', probed: true },
  { runId: 'run_20260812T133934Z_468702', probed: false },
] as const;

const UNSTARTED: RunId = RunIdSchema.parse(REPORTED[2].runId);

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

/** Intake's own two writes for a run it accepted: the event, and the framing
 * wake that is the hand-off (KAR-19.1 AC1). */
function seedSubmitted(db: Db, runId: string, probed: boolean): void {
  appendEvents(db, [
    {
      runId: runId as RunId,
      ts: T0,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        input: { kind: 'text', text: 'Migrate the design system across packages/ui' },
        cwd: '/work/example-web',
        permission: 'worktree',
        provenance: { by: 'cli', at: '2026-08-12T13:34:01.000Z' },
      },
    },
    ...(probed
      ? [
          {
            runId: runId as RunId,
            ts: T0 + 400,
            kind: 'provider.probed',
            v: 1,
            epoch: 1,
            payload: {
              provider: 'mock',
              version: '0.0.0',
              capsJson: { promptCapabilities: {} },
              binarySha256: 'd'.repeat(64),
            },
          },
        ]
      : []),
  ]);
  scheduleWake(db, { runId, nodeId: FRAMING_NODE, wakeAt: T0, reason: 'poll' });
}

async function serve(dataDir: string): Promise<Served> {
  const db = openLedger(dataDir);
  for (const run of REPORTED) seedSubmitted(db, run.runId, run.probed);
  await seedSpecGateRun(db);

  const view = openLedgerView(dataDir);
  setLedgerView(view);
  setIntakePorts({
    db,
    epoch: 1,
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
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

const post = (origin: string, path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const cancel = (origin: string, runId: string, body: unknown = {}): Promise<Response> =>
  post(origin, `/api/runs/${runId}/cancel`, body);

/** Every event kind of `runId`, with its seq, in `seq` order. */
const eventsOf = (db: Db, runId: string): { seq: number; kind: string }[] =>
  db
    .prepare<{ seq: number; kind: string }>(
      'SELECT seq, kind FROM event WHERE run_id = ? ORDER BY seq',
    )
    .all(runId);

const kindsOf = (db: Db, runId: string): string[] => eventsOf(db, runId).map((row) => row.kind);

const countOf = (db: Db, runId: string, kind: string): number =>
  kindsOf(db, runId).filter((one) => one === kind).length;

const payloadOf = (db: Db, runId: string, kind: string): Record<string, unknown> =>
  JSON.parse(
    db
      .prepare<{ payload: string }>(
        'SELECT payload FROM event WHERE run_id = ? AND kind = ? ORDER BY seq LIMIT 1',
      )
      .get(runId, kind)?.payload ?? '{}',
  ) as Record<string, unknown>;

/** The ledger head after each committed batch, for the whole of `work`. */
async function commits(db: Db, work: () => Promise<void>): Promise<number[]> {
  const heads: number[] = [];
  const off = onCommitted(() => heads.push(headSeq(db)));
  try {
    await work();
  } finally {
    off();
  }
  return heads;
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('EPIC-19-S39 — a run that never started can finally be got rid of (AC3, AC4)', () => {
  it('answers 200 rather than 422 spec_not_approved, and ends the run', async ({ tmp }) => {
    served = await serve(tmp);
    const response = await cancel(served.origin, UNSTARTED);

    expect(response.status).toBe(200);
    expect((await response.json()) as ControlBody).toMatchObject({
      runId: UNSTARTED,
      status: 'aborted',
      appended: true,
    });
    expect(kindsOf(served.db, UNSTARTED)).toEqual([
      'task.submitted',
      'run.cancel.requested',
      'run.aborted',
    ]);
  });

  it('appends both events at consecutive seq in one commit, so cancelling is never observable', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const { db, origin } = served;

    const heads = await commits(db, async () => {
      expect((await cancel(origin, UNSTARTED)).status).toBe(200);
    });

    const rows = eventsOf(db, UNSTARTED);
    const requested = rows.find((row) => row.kind === 'run.cancel.requested');
    const aborted = rows.find((row) => row.kind === 'run.aborted');
    expect(requested?.seq).toBeDefined();
    expect(aborted?.seq).toBe((requested?.seq ?? 0) + 1);

    // One commit, and it carried both: no reader on any connection could have
    // seen the run at `cancelling` with nothing in flight to finish it.
    expect(heads).toEqual([aborted?.seq]);
  });

  it('records the mode on the request, so the abort is not mistaken for a defect', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    await cancel(served.origin, UNSTARTED);
    expect(payloadOf(served.db, UNSTARTED, 'run.cancel.requested')).toEqual({
      mode: 'cooperative',
    });
    expect(payloadOf(served.db, UNSTARTED, 'run.aborted')).toEqual({
      outcome: 'failed',
      criteriaSatisfied: [],
    });
  });

  it('takes the framing wake with it, so nothing is dispatched for a stopped run', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    expect(readWakes(served.db, UNSTARTED)).toHaveLength(1);

    await cancel(served.origin, UNSTARTED);

    expect(readWakes(served.db, UNSTARTED)).toEqual([]);
  });

  it('leaves pause and resume refusing 422 spec_not_approved, and the ledger untouched', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const before = kindsOf(served.db, UNSTARTED);

    for (const verb of ['pause', 'resume'] as const) {
      const response = await post(served.origin, `/api/runs/${UNSTARTED}/${verb}`);
      expect(response.status).toBe(422);
      expect(((await response.json()) as ErrorBody).error.code).toBe('spec_not_approved');
    }

    expect(kindsOf(served.db, UNSTARTED)).toEqual(before);
  });
});

suite('EPIC-19-S39 — the same command at the open F1.3 gate (AC5)', () => {
  it('writes the option the operator effectively chose and consumes the gate wake', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const { db, origin } = served;
    expect(readWakes(db, SPEC_RUN)).toHaveLength(1);

    const heads = await commits(db, async () => {
      expect((await cancel(origin, SPEC_RUN)).status).toBe(200);
    });

    expect(kindsOf(db, SPEC_RUN).slice(-2)).toEqual(['human.responded', 'run.aborted']);
    expect(payloadOf(db, SPEC_RUN, 'human.responded')).toMatchObject({ optionId: 'abandon' });
    // The response, the abort and the row that was the wait: one transaction.
    expect(heads).toHaveLength(1);
    expect(readWakes(db, SPEC_RUN)).toEqual([]);
    // And no second vocabulary: the gate path records the option, not a
    // `run.cancel.requested` for a ladder with no rungs.
    expect(countOf(db, SPEC_RUN, 'run.cancel.requested')).toBe(0);
  });
});

suite('EPIC-19-S40 — the three stuck runs, cleared by one command each', () => {
  it('takes the same path for both reported ledger shapes', async ({ tmp }) => {
    served = await serve(tmp);

    for (const run of REPORTED) {
      const response = await cancel(served.origin, run.runId);
      expect(response.status, run.runId).toBe(200);
      expect((await response.json()) as ControlBody).toMatchObject({ status: 'aborted' });
      // The same two events in the same order, whichever shape the run had.
      expect(kindsOf(served.db, run.runId).slice(-2)).toEqual([
        'run.cancel.requested',
        'run.aborted',
      ]);
    }

    // AC7 — and none of them is live any more.
    const active = await fetch(`${served.origin}/api/runs?status=active`);
    const listed = ((await active.json()) as { runs: { runId: string }[] }).runs.map(
      (row) => row.runId,
    );
    for (const run of REPORTED) expect(listed).not.toContain(run.runId);

    // …while a plain list still holds every one of them, with a terminal
    // status. A cancel ends a run; it does not delete one (NF8).
    const all = await fetch(`${served.origin}/api/runs`);
    const rows = ((await all.json()) as { runs: { runId: string; status: string }[] }).runs;
    for (const run of REPORTED) {
      expect(rows.find((row) => row.runId === run.runId)?.status).toBe('aborted');
    }
  });
});

suite('EPIC-19-S41 — repeats, an ended run, and a run that is not there (AC6)', () => {
  it('answers a second cancel with the seq already in the log and appends nothing', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const first = (await (await cancel(served.origin, UNSTARTED)).json()) as ControlBody;

    const repeat = await cancel(served.origin, UNSTARTED);

    expect(repeat.status).toBe(200);
    const body = (await repeat.json()) as ControlBody;
    expect(body).toMatchObject({ seq: first.seq, appended: false, status: 'aborted' });
    expect(countOf(served.db, UNSTARTED, 'run.aborted')).toBe(1);
  });

  it('answers a cancel of a completed run with the terminal status it already had', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const { db, origin } = served;
    const [completed] = appendEvents(db, [
      {
        runId: UNSTARTED,
        ts: T0 + 1_000,
        kind: 'run.completed',
        v: 1,
        epoch: 1,
        payload: { outcome: 'succeeded', criteriaSatisfied: [] },
      },
    ]);

    const response = await cancel(origin, UNSTARTED, { mode: 'forceful' });

    expect(response.status).toBe(200);
    expect((await response.json()) as ControlBody).toMatchObject({
      seq: completed,
      appended: false,
      status: 'completed',
    });
    expect(countOf(db, UNSTARTED, 'run.aborted')).toBe(0);
  });

  it('answers an unknown run id with 404 run_not_found and writes nothing anywhere', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    const before = headSeq(served.db);

    const response = await cancel(served.origin, 'run_20260812T133401Z_ffffff');

    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorBody).error.code).toBe('run_not_found');
    expect(headSeq(served.db)).toBe(before);
  });
});
