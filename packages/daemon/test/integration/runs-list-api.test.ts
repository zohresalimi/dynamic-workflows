/**
 * KAR-19.1 AC4 — `GET /api/runs`, which
 * [11 §6](../../../../docs/11-api-and-realtime.md) has documented since the
 * architecture was written and which has never existed.
 *
 * The un-framed clause is the one that matters and it is the trap: a list built
 * from `RunState` alone omits exactly the runs that are stuck *before*
 * `run.created`, which are the only runs an operator in the 2026-08-12
 * situation is looking for. So this spec asserts the presence of a run whose
 * whole ledger is one `task.submitted`, with a status it can act on — and it
 * asserts it first.
 *
 * Real booted daemon, real HTTP, real file-backed ledger: a route can wire a
 * correct projection to the wrong status code, and a spec that called the
 * function would never notice.
 *
 * Verifies: EPIC-19-S3 · KAR-19.1 AC4 · test plan #4
 */
import type { RunId, TaskSpec } from '@DeFlow/core';
import { sealTaskSpec } from '@DeFlow/core';
import { appendEvents, openLedger } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';
import { framed } from './support/spec-gate-run.ts';

const fetch = authorizedFetch();

const T0 = 1_754_470_000_000;
const UNFRAMED = 'run_20260806T101500Z_aaaaa1' as RunId;
const FINISHED = 'run_20260806T101000Z_bbbbb2' as RunId;

interface RunListEntry {
  readonly runId: string;
  readonly status: string;
  readonly label: string;
  readonly title: string;
  readonly createdAt: string;
  readonly headSeq: number;
  readonly planVersion: number;
  readonly cost: unknown;
}

interface RunListBody {
  readonly runs: readonly RunListEntry[];
  readonly cursor: string | null;
  readonly more: boolean;
}

/**
 * Two runs, seeded oldest first: one that reached `run.completed`, and one that
 * has been accepted and never framed.
 */
async function seed(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = openLedger(dataDir);
  const spec: TaskSpec = await sealTaskSpec(framed());
  const submitted = (runId: RunId, ts: number, raw: string) => ({
    runId,
    ts,
    kind: 'task.submitted',
    v: 1,
    epoch: 1,
    payload: {
      sha256: 'a'.repeat(64),
      raw,
      provenance: { kind: 'text' as const, by: 'cli' as const, submittedAt: ts },
    },
  });

  appendEvents(db, [
    submitted(FINISHED, T0, 'Upgrade the router\nand keep the API stable'),
    {
      runId: FINISHED,
      ts: T0 + 1,
      kind: 'run.created',
      v: 1,
      epoch: 1,
      payload: { spec, cwd: '/repo', repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: FINISHED,
      ts: T0 + 2,
      kind: 'run.completed',
      v: 1,
      epoch: 1,
      payload: { outcome: 'succeeded', criteriaSatisfied: [] },
    },
    submitted(UNFRAMED, T0 + 10, 'Migrate the checkout module to Vue 3'),
  ]);
  db.close();
}

async function bootAt(dataDir: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, stop: () => booted.shutdown() };
}

suite('EPIC-19-S3 — GET /api/runs (AC4)', () => {
  it('lists both runs newest first, and hides neither', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir);
    const daemon = await bootAt(dataDir);
    try {
      const response = await fetch(`${daemon.origin}/api/runs?limit=10`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as RunListBody;

      expect(body.runs.map((run) => run.runId)).toEqual([UNFRAMED, FINISHED]);

      const unframed = body.runs[0];
      expect(unframed?.status).toBe('created');
      // The whole point of the endpoint: a run the operator can *act on*,
      // described in the words every other surface uses.
      expect(unframed?.label).toBe('submitted — waiting to be framed');
      expect(unframed?.title).toBe('Migrate the checkout module to Vue 3');
      expect(unframed?.createdAt).toBe(new Date(T0 + 10).toISOString());
      expect(unframed?.headSeq).toBeGreaterThan(0);
      expect(unframed?.planVersion).toBe(0);
      expect(unframed?.cost).toBeDefined();

      const finished = body.runs[1];
      expect(finished?.status).toBe('completed');
      expect(finished?.label).toBe('completed');
      // A framed run is titled by its spec's goal rather than by the raw text
      // the operator pasted: the goal is what the run is now about.
      expect(finished?.title.length).toBeGreaterThan(0);
      expect(finished?.title).not.toContain('\n');
    } finally {
      await daemon.stop();
    }
  });

  it('filters with status=active: the completed run is out, the un-framed one is in', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir);
    const daemon = await bootAt(dataDir);
    try {
      const response = await fetch(`${daemon.origin}/api/runs?status=active`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as RunListBody;

      expect(body.runs.map((run) => run.runId)).toEqual([UNFRAMED]);
    } finally {
      await daemon.stop();
    }
  });

  it('pages with limit and cursor, and says whether more follow', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir);
    const daemon = await bootAt(dataDir);
    try {
      const first = (await (
        await fetch(`${daemon.origin}/api/runs?limit=1`)
      ).json()) as RunListBody;
      expect(first.runs.map((run) => run.runId)).toEqual([UNFRAMED]);
      expect(first.more).toBe(true);
      expect(first.cursor).toBe(UNFRAMED);

      const next = (await (
        await fetch(`${daemon.origin}/api/runs?limit=1&cursor=${first.cursor ?? ''}`)
      ).json()) as RunListBody;
      expect(next.runs.map((run) => run.runId)).toEqual([FINISHED]);
      expect(next.more).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('refuses an unauthenticated request with 401', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir);
    const daemon = await bootAt(dataDir);
    try {
      const response = await globalThis.fetch(`${daemon.origin}/api/runs`);
      expect(response.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });
});
