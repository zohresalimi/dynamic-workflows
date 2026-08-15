/**
 * KAR-22.1 AC7 — a run created after this story carries its project id, on the
 * wire and in the ledger, and an id nothing holds is refused **before** a run
 * exists.
 *
 * That last clause is the one with teeth. Intake's own rule (KAR-10.1 AC5) is
 * that a rejected submission leaves no half-born run, and an unknown project has
 * to be refused under that rule rather than after the `task.submitted` append —
 * otherwise the failure mode this story exists to end (a run nobody can find)
 * is reproduced by the very field that was meant to end it.
 *
 * Verifies: EPIC-22-S15 · KAR-22.1 AC7 · test plan #13, #14
 */
import { openRead } from '@DeFlow/ledger';
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';

const fetch = authorizedFetch();

interface Envelope {
  readonly error: { readonly code: string; readonly detail: Record<string, unknown> };
}

async function bootAt(dataDir: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  await mkdir(dataDir, { recursive: true });
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, stop: () => booted.shutdown() };
}

async function submit(origin: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Every `task.submitted` payload in the ledger, parsed.
 *
 * `openRead`, not `openLedger`: the daemon under test holds the one write
 * connection SQLite permits, and a second writer in this process is refused
 * with `LedgerAlreadyOpen` — which is the ledger being right, not the spec
 * finding a bug.
 */
function submittedPayloads(dataDir: string): { runId: string; provenance: unknown }[] {
  const db = openRead(join(dataDir, 'ledger.db'));
  try {
    return db
      .prepare<{ run_id: string; payload: string }>(
        "SELECT run_id, payload FROM event WHERE kind = 'task.submitted' ORDER BY seq",
      )
      .all()
      .map((row) => ({
        runId: row.run_id,
        provenance: (JSON.parse(row.payload) as { provenance: unknown }).provenance,
      }));
  } finally {
    db.close();
  }
}

suite('EPIC-22-S15 — a run knows which project it belongs to', () => {
  it('stamps the project id onto task.submitted and reports it on the run', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(dataDir);
    try {
      const created = (await (
        await fetch(`${daemon.origin}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'checkout', path: repo.dir }),
        })
      ).json()) as { project: { id: string } };

      const response = await submit(daemon.origin, {
        input: { kind: 'text', text: 'migrate the checkout module' },
        cwd: repo.dir,
        permission: 'worktree',
        projectId: created.project.id,
      });
      expect(response.status).toBe(201);
      const { runId } = (await response.json()) as { runId: string };

      const payloads = submittedPayloads(dataDir);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.provenance).toMatchObject({ projectId: created.project.id });

      const summary = (await (await fetch(`${daemon.origin}/api/runs/${runId}`)).json()) as {
        projectId?: string;
      };
      expect(summary.projectId).toBe(created.project.id);
    } finally {
      await daemon.stop();
    }
  });

  it('refuses a project id nothing holds, and creates no run at all', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(dataDir);
    try {
      const response = await submit(daemon.origin, {
        input: { kind: 'text', text: 'a run with nowhere to belong' },
        cwd: repo.dir,
        permission: 'worktree',
        projectId: 'prj_20260101T000000Z_ffffff',
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Envelope;
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.detail).toMatchObject({ field: 'projectId' });

      // KAR-10.1 AC5 — nothing half-born.
      expect(submittedPayloads(dataDir)).toEqual([]);
      const runs = (await (await fetch(`${daemon.origin}/api/runs`)).json()) as {
        runs: readonly unknown[];
      };
      expect(runs.runs).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it('refuses a malformed project id with the same field name', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const response = await submit(daemon.origin, {
        input: { kind: 'text', text: 'x' },
        cwd: repo.dir,
        permission: 'worktree',
        projectId: 'not-an-id',
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Envelope).error.detail).toMatchObject({
        field: 'projectId',
      });
    } finally {
      await daemon.stop();
    }
  });

  it('still accepts a submission with no project id at all', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(dataDir);
    try {
      const response = await submit(daemon.origin, {
        input: { kind: 'text', text: 'a terminal-submitted run' },
        cwd: repo.dir,
        permission: 'worktree',
      });
      expect(response.status).toBe(201);
      const payloads = submittedPayloads(dataDir);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.provenance).not.toHaveProperty('projectId');
    } finally {
      await daemon.stop();
    }
  });
});
