/**
 * KAR-17.2 AC1 — `GET /api/runs/:id/patches`: the marks on the scrubber's rail
 * that are not versions.
 *
 * Verifies: EPIC-17-S9 · KAR-17.2 AC1
 *
 * `GET /api/runs/:id/plans` is the version rail and cannot answer this. A patch
 * that was refused produced no version, so it has no tick — and *"the proposal
 * is recorded even when it was refused"* is a property of the ledger that the
 * UI had no way to read. This is that way.
 *
 * Integration rather than unit for the reason every read endpoint here is:
 * proving `listPlanPatches` reduces correctly is not the same as proving the
 * scrubber can *reach* it. Every assertion below is against JSON that came back
 * over a socket from a DeFlowd on an ephemeral port, reading a real file-backed
 * ledger through the same read-only connection production uses.
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, type Db, type EventDraft, openLedger } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260811T101500Z_b7c9d2');
const T0 = 1_786_438_900_000;
const EPOCH = 3;
const HASH = (digit: string) => `sha256-${digit.repeat(64)}`;

const draft = (kind: string, payload: unknown, v = 1): EventDraft =>
  ({ runId: RUN, ts: T0, kind, v, epoch: EPOCH, payload }) as EventDraft;

const proposal = (id: string, reason: string): EventDraft =>
  draft('plan.patch.proposed', {
    patch: {
      id,
      reason,
      proposedBy: 'planner',
      ops: [{ op: 'insert-nodes', nodes: [], edges: [] }],
    },
  });

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

async function serve(tmp: string, events: readonly EventDraft[]): Promise<Served> {
  const db = openLedger(tmp);
  appendEvents(db, [...events]);

  const view = openLedgerView(tmp);
  setLedgerView(view);
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
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const get = async (path: string): Promise<Response> => {
  const target = served;
  if (target === undefined) throw new Error('no server');
  return fetch(`${target.origin}${path}`);
};

interface PatchRow {
  readonly patchId: string;
  readonly seq: number;
  readonly reason: string;
  readonly proposedBy: string | null;
  readonly outcome: string;
  readonly decidedSeq: number | null;
  readonly version: number | null;
  readonly decision: string | null;
  readonly rule: string | null;
  readonly by: string | null;
}

suite('KAR-17.2 AC1 — the rail records refusals as well as applications', () => {
  it('serves the refused proposal, with the rule that refused it and who did', async ({ tmp }) => {
    served = await serve(tmp, [
      draft('run.started', { planHash: HASH('1') }),
      proposal('p-widen-scope', 'the payment step needs to edit the shared money helper'),
      draft('plan.patch.rejected', {
        patchId: 'p-widen-scope',
        rule: 'escalates-permission',
        by: 'policy',
        diagnostics: [],
      }),
    ]);

    const response = await get(`/api/runs/${RUN}/patches`);
    expect(response.status).toBe(200);

    const rows = (await response.json()) as PatchRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patchId: 'p-widen-scope',
      outcome: 'rejected',
      rule: 'escalates-permission',
      by: 'policy',
      // Verbatim. A summarised reason is the one thing this row must never be:
      // it is what the panel shows beside "what was proposed".
      reason: 'the payment step needs to edit the shared money helper',
      version: null,
    });
    expect(rows[0]?.seq).toBeGreaterThan(0);
  });

  it('serves an applied proposal beside it, so the rail is one chronology', async ({ tmp }) => {
    served = await serve(tmp, [
      draft('run.started', { planHash: HASH('1') }),
      proposal('p-insert-review', 'a security review is required before checkout ships'),
      draft(
        'plan.patched',
        {
          version: 2,
          fromHash: HASH('1'),
          toHash: HASH('2'),
          patchId: 'p-insert-review',
          decision: {
            decision: 'auto',
            by: 'policy',
            rule: 'adds-no-write-capability',
            at: '2026-08-11T09:01:45.000Z',
          },
        },
        2,
      ),
      proposal('p-widen-scope', 'the payment step needs the shared money helper'),
      draft('plan.patch.rejected', {
        patchId: 'p-widen-scope',
        rule: 'escalates-permission',
        by: 'policy',
        diagnostics: [],
      }),
    ]);

    const rows = (await get(`/api/runs/${RUN}/patches`)).json() as Promise<PatchRow[]>;

    expect((await rows).map((row) => [row.patchId, row.outcome])).toEqual([
      ['p-insert-review', 'applied'],
      ['p-widen-scope', 'rejected'],
    ]);
    expect((await rows)[0]).toMatchObject({ version: 2, decision: 'auto' });
  });

  it('is bounded, and says what bound it applied', async ({ tmp }) => {
    served = await serve(tmp, [
      draft('run.started', { planHash: HASH('1') }),
      ...Array.from({ length: 6 }, (_unused, index) => proposal(`p-${index}`, 'again')),
    ]);

    const response = await get(`/api/runs/${RUN}/patches?limit=2`);

    expect((await response.json()) as PatchRow[]).toHaveLength(2);
    expect(response.headers.get('x-deflow-limit')).toBe('2');
  });

  it('answers an unknown run with run_not_found, like every other read', async ({ tmp }) => {
    served = await serve(tmp, [draft('run.started', { planHash: HASH('1') })]);

    const response = await get('/api/runs/run_20260811T101500Z_000000/patches');

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'run_not_found',
    );
  });
});
