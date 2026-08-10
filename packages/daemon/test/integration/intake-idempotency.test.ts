/**
 * KAR-15.5 test plan #4 — `Idempotency-Key` on run creation, and **where the
 * key is stored** (docs/11-api-and-realtime.md §11.3).
 *
 * The route half of this — "a repeat returns the original runId" — has been
 * true since KAR-10.1. What this spec adds is the two claims §11.3 makes and
 * the plan's red condition names: the response is *byte-identical* rather than
 * merely equivalent, and the key lives in the **effect journal alongside
 * engine-level idempotency keys, not in a separate table**.
 *
 * Byte-identical matters because the body carries a `seq`, and a repeat that
 * re-derived it would answer with whatever the ledger looks like now. Memoising
 * the response verbatim is what an effect journal is *for*: the intent row
 * holds the result, and a retry reads it back rather than recomputing it.
 *
 * Integration, over a real booted daemon and a real repository, because the
 * claim spans the header, the route, the journal and the file the next daemon
 * life reopens.
 *
 * Verifies: EPIC-15-S35 · AC5, AC8
 */
import { parseIkey } from '@DeFlow/core';
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';

const fetch = authorizedFetch();

async function bootAt(dataDir: string): Promise<{ booted: Booted; origin: string }> {
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { booted, origin: `http://127.0.0.1:${address.port}` };
}

const submit = (origin: string, body: unknown, key: string): Promise<Response> =>
  fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });

interface EffectRowShape {
  readonly ikey: string;
  readonly run_id: string;
  readonly kind: string;
  readonly state: string;
  readonly result_json: string | null;
}

suite('EPIC-15-S35 — the same key twice (AC5)', () => {
  it('returns the original 201 body byte-identically, and mints exactly one run', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const request = {
        input: { kind: 'text', text: 'Migrate the design system across packages/ui' },
        cwd: repo.dir,
        permission: 'worktree' as const,
      };

      const first = await submit(origin, request, 'k1');
      const second = await submit(origin, request, 'k1');

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      // Byte-identical, not merely deep-equal: the body carries a `seq`, and a
      // repeat that re-derived it would answer with whatever the ledger looks
      // like now rather than with what the first call actually returned.
      expect(await second.text()).toBe(await first.text());

      const runs = booted.db
        .prepare<{ run_id: string }>('SELECT DISTINCT run_id FROM event')
        .all()
        .map((row) => row.run_id);
      expect(runs).toHaveLength(1);

      const submitted = booted.db
        .prepare<{ n: number }>(`SELECT count(*) AS n FROM event WHERE kind = 'task.submitted'`)
        .get()?.n;
      expect(submitted).toBe(1);
    } finally {
      await booted.shutdown();
    }
  });

  it('stores the key in the effect journal, not in a table of its own', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const body = await (
        await submit(
          origin,
          { input: { kind: 'text', text: 'ship it' }, cwd: repo.dir, permission: 'worktree' },
          'k1',
        )
      ).text();

      const tables = booted.db
        .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain('intake_key');

      const rows = booted.db
        .prepare<EffectRowShape>(
          `SELECT ikey, run_id, kind, state, result_json FROM effect WHERE kind = 'intake'`,
        )
        .all();
      expect(rows).toHaveLength(1);

      const row = rows[0] as EffectRowShape;
      // A repeat is answered out of the journal, so the memoised result *is*
      // the 201 body.
      expect(row.result_json).toBe(body);
      expect(row.state).toBe('done');
      expect(row.ikey).toContain('k1');
    } finally {
      await booted.shutdown();
    }
  });

  it('keeps two different keys apart, and mints two runs for them', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const request = {
        input: { kind: 'text', text: 'ship it' },
        cwd: repo.dir,
        permission: 'worktree' as const,
      };
      const first = (await (await submit(origin, request, 'k1')).json()) as { runId: string };
      const second = (await (await submit(origin, request, 'k2')).json()) as { runId: string };

      expect(second.runId).not.toBe(first.runId);
      expect(booted.db.prepare<{ n: number }>(`SELECT count(*) AS n FROM effect`).get()?.n).toBe(2);
    } finally {
      await booted.shutdown();
    }
  });

  it('answers a retry that arrives after a restart, because the journal is on disk', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const request = {
      input: { kind: 'text', text: 'ship it' },
      cwd: repo.dir,
      permission: 'worktree' as const,
    };

    const first = await bootAt(`${tmp}/data`);
    let original: string;
    try {
      original = await (await submit(first.origin, request, 'k1')).text();
    } finally {
      await first.booted.shutdown();
    }

    const second = await bootAt(`${tmp}/data`);
    try {
      const retried = await submit(second.origin, request, 'k1');
      expect(retried.status).toBe(201);
      expect(await retried.text()).toBe(original);
    } finally {
      await second.booted.shutdown();
    }
  });
});

suite('EPIC-15-S38 — the API key is a distinct concept from the engine key (AC8)', () => {
  it('journals it under a namespace no (runId, nodeId, attempt, ordinal) key can produce', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      // A client that sent something *shaped* like an engine key must still not
      // land in the engine's namespace — that is the whole of "conflating the
      // two would let a client reach into the effect journal".
      await submit(
        origin,
        { input: { kind: 'text', text: 'ship it' }, cwd: repo.dir, permission: 'worktree' },
        'run_20260810T101500Z_aa0001/impl-auth/0/0',
      );

      const ikey = booted.db
        .prepare<{ ikey: string }>(`SELECT ikey FROM effect WHERE kind = 'intake'`)
        .get()?.ikey as string;

      expect(() => parseIkey(ikey)).toThrow();
    } finally {
      await booted.shutdown();
    }
  });
});
