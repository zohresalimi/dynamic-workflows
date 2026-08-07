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
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe('input.text');
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
    } finally {
      await booted.shutdown();
    }
  });
});
