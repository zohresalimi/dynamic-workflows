/**
 * KAR-10.1 AC7 / test plan #6 — `DeFlow run "…"` against a real booted
 * daemon: the CLI is a client of the HTTP API, never a second implementation.
 *
 * Verifies: KAR-10.1 AC7 · EPIC-10-S1 (CLI scenario) · test plan #6
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { readRange, type StoredEvent } from '@DeFlow/ledger';
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { expect, describe as suite } from 'vitest';
import { runTask } from '../../src/index.ts';

/**
 * Every request this spec makes carries the daemon's bearer token (KAR-15.2) —
 * the `fetch` below, and the `token` option `DeFlow run` forwards to the same
 * `Authorization` header through the shared client.
 */
const fetch = authorizedFetch();

async function bootAt(dataDir: string): Promise<{ booted: Booted; origin: string }> {
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { booted, origin: `http://127.0.0.1:${address.port}` };
}

/** `event`, modulo runId, seq, timestamps and `provenance.by` — the modulo
 * AC7 states verbatim ("byte-identical modulo ids and timestamps"), plus
 * `by` itself, which is the one field the two submitters are expected to
 * disagree on. */
function normalised(event: StoredEvent | undefined): unknown {
  const payload = event?.payload as { provenance: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  return {
    kind: event?.kind,
    v: event?.v,
    payload: {
      ...payload,
      provenance: { ...payload.provenance, submittedAt: 0, by: 'x' },
    },
  };
}

suite('DeFlow run — a client of the HTTP API, not a second engine (AC7)', () => {
  it('returns status "awaiting-spec-approval" and schedules nothing', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const result = await runTask('Migrate the design system across packages/ui', {
        baseUrl: origin,
        token: TEST_DAEMON_TOKEN,
        cwd: repo.dir,
      });

      expect(result.status).toBe('awaiting-spec-approval');
      expect(result.runId).toMatch(/^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/);

      const events = readRange(booted.db, RunIdSchema.parse(result.runId), 0, 10).events;
      expect(events.some((event) => event.kind === 'node.scheduled')).toBe(false);
    } finally {
      await booted.shutdown();
    }
  });

  it('records provenance.by: "cli"', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const result = await runTask('Fix the flaky checkout test', {
        baseUrl: origin,
        token: TEST_DAEMON_TOKEN,
        cwd: repo.dir,
      });

      const [event] = readRange(booted.db, RunIdSchema.parse(result.runId), 0, 1).events;
      expect(event?.payload).toMatchObject({ provenance: { by: 'cli' } });
    } finally {
      await booted.shutdown();
    }
  });

  it('produces a ledger byte-identical (modulo ids and timestamps) to the same text over HTTP', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const text = 'Migrate the design system across packages/ui';

      const cli = await runTask(text, { baseUrl: origin, token: TEST_DAEMON_TOKEN, cwd: repo.dir });
      const http = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { kind: 'text', text },
          cwd: repo.dir,
          permission: 'worktree',
        }),
      });
      const httpBody = (await http.json()) as { runId: string };

      const cliEvent = readRange(booted.db, RunIdSchema.parse(cli.runId), 0, 1).events[0];
      const httpEvent = readRange(booted.db, RunIdSchema.parse(httpBody.runId), 0, 1).events[0];

      expect(normalised(cliEvent)).toEqual(normalised(httpEvent));
    } finally {
      await booted.shutdown();
    }
  });
});
