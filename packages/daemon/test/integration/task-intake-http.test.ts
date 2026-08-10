/**
 * KAR-10.1 AC1 — `POST /api/runs` over a real HTTP server, a real booted
 * daemon and a real repository.
 *
 * `submitTask` itself is exercised thoroughly in ./task-intake.test.ts; this
 * file proves the wire contract on top of it — the 201 body, the 4xx shape, an
 * `Idempotency-Key` repeat over the network — because a route can wire a
 * correct function to the wrong status code, and a spec that only calls the
 * function directly would never notice.
 *
 * Verifies: EPIC-10-S1 (HTTP scenario), KAR-10.1 AC1, AC5, AC6
 */
import { it, makeRepo } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';

async function bootAt(
  dataDir: string,
  repoDir: string,
): Promise<{ booted: Booted; origin: string }> {
  const booted = await boot({ dataDir, port: 0, dev: false });
  const address = booted.http.server.address() as AddressInfo;
  return { booted, origin: `http://127.0.0.1:${address.port}` };
}

/** Every event kind the daemon's ledger holds, in `seq` order. The route's
 * effect on the log is part of its contract, and a status code cannot show it. */
function eventKinds(booted: Booted): string[] {
  return booted.db
    .prepare<{ kind: string }>('SELECT kind FROM event ORDER BY seq')
    .all()
    .map((row) => row.kind);
}

suite('POST /api/runs — the wire contract (AC1)', () => {
  it('returns 201 { runId, seq, status: "awaiting-spec-approval" } for free text', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`, repo.dir);
    try {
      const response = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { kind: 'text', text: 'Migrate the design system across packages/ui' },
          cwd: repo.dir,
          budget: { costUsd: 25, wallclockMs: 14_400_000 },
          permission: 'worktree',
        }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as { runId: string; seq: number; status: string };
      expect(body.runId).toMatch(/^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/);
      expect(body.seq).toBeGreaterThan(0);
      expect(body.status).toBe('awaiting-spec-approval');
      // EPIC-10-S1: creating a run appends `task.submitted` and stops. No
      // `run.created` — its payload carries the `TaskSpec` the framing
      // interview (KAR-10.2) has not produced yet — and no `node.scheduled`.
      expect(eventKinds(booted)).toEqual(['task.submitted']);
    } finally {
      await booted.shutdown();
    }
  });

  it('rejects an empty text with a 4xx naming input.text', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`, repo.dir);
    try {
      const response = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { kind: 'text', text: '' },
          cwd: repo.dir,
          permission: 'worktree',
        }),
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      // KAR-15.1's closed envelope: the offending field is `detail.field`, and
      // the code is the one a client branches on.
      const body = (await response.json()) as {
        error: { code: string; detail: { field: string } };
      };
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.detail.field).toBe('input.text');
    } finally {
      await booted.shutdown();
    }
  });

  it('honours Idempotency-Key: a repeat returns the original runId, one run', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`, repo.dir);
    try {
      const request = {
        input: { kind: 'text', text: 'Migrate the design system across packages/ui' },
        cwd: repo.dir,
        permission: 'worktree' as const,
      };

      const first = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
        body: JSON.stringify(request),
      });
      const second = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
        body: JSON.stringify(request),
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = (await first.json()) as { runId: string };
      const secondBody = (await second.json()) as { runId: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      // EPIC-10-S5: one submission's worth of events for two POSTs — the
      // retry appended nothing at all.
      expect(eventKinds(booted)).toEqual(['task.submitted']);
    } finally {
      await booted.shutdown();
    }
  });
});
