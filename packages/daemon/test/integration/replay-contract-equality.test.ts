/**
 * KAR-16.5 test plan #4 — the harness has not drifted from the contract.
 *
 * Verifies: EPIC-16-S31 · AC1, AC2
 *
 * *"Red when the harness drifted from the contract."* The risk register puts it
 * more sharply: *"The replay harness drifts from the live contract and dev stops
 * predicting production… if the harness ever needs a special case in the UI,
 * that is the bug."*
 *
 * So this asks the **same question of two daemons** and diffs the answers. One
 * is served the recorded `ledger.db` `gate-failure-repair` was produced into by
 * a real repair loop; the other is `DeFlow replay` over that same run's
 * `events.jsonl` export. Every route AC1 names is fetched from both, and the
 * JSON must match — not merely in shape, but value for value, because a shape
 * comparison would pass a harness that served an empty list where the daemon
 * serves a populated one.
 *
 * The two daemons are booted **one after the other, never at once**: the ledger
 * view, the auth record and the epoch are per-process singletons by design (one
 * daemon per process, enforced by the lease), so two live at the same time would
 * be two daemons reading one another's ledger — and the diff would pass for the
 * worst possible reason.
 */
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { startReplay } from '../../src/replay/harness.ts';
import { parseSpeed } from '../../src/replay/speed.ts';
import { serve } from './support/stream-daemon.ts';

const FIXTURE = fileURLToPath(
  new URL('../../../../test/fixtures/runs/gate-failure-repair/', import.meta.url),
);

const RUN = 'run_20260810T090000Z_9f31ab';

const authorized = authorizedFetch();

/** Every route AC1 names, as one run's request paths. */
const ROUTES = (runId: string): readonly string[] => [
  `/api/runs/${runId}`,
  `/api/runs/${runId}/events?since=0`,
  `/api/runs/${runId}/snapshot?seq=head`,
  `/api/runs/${runId}/plans`,
  `/api/runs/${runId}/plans/1`,
  `/api/runs/${runId}/plans/diff?from=1&to=2`,
  `/api/runs/${runId}/nodes/impl`,
  `/api/runs/${runId}/gates`,
  `/api/runs/${runId}/criteria`,
  `/api/runs/${runId}/diff`,
];

interface Answer {
  readonly status: number;
  readonly apiVersion: string | null;
  readonly body: unknown;
}

/** Fetches every route from `origin`, in order. */
async function answers(origin: string, runId: string): Promise<Map<string, Answer>> {
  const collected = new Map<string, Answer>();
  for (const path of ROUTES(runId)) {
    const response = await authorized(`${origin}${path}`);
    collected.set(path, {
      status: response.status,
      apiVersion: response.headers.get('X-DeFlow-Api'),
      body: (await response.json()) as unknown,
    });
  }
  return collected;
}

suite('EPIC-16-S31 — a replay answers exactly what a live daemon answers', () => {
  it('serves byte-identical bodies for every route the acceptance criteria name', async ({
    tmp,
  }) => {
    // ── the live daemon, over the ledger a real repair loop wrote ───────────
    const live = join(tmp, 'live');
    mkdirSync(live, { recursive: true });
    cpSync(join(FIXTURE, 'ledger.db'), join(live, 'ledger.db'));
    if (existsSync(join(FIXTURE, 'blobs'))) {
      cpSync(join(FIXTURE, 'blobs'), join(live, 'blobs'), { recursive: true });
    }

    const served = await serve(live);
    let fromLive: Map<string, Answer>;
    try {
      fromLive = await answers(served.origin, RUN);
    } finally {
      await served.close();
    }

    // ── the same run, replayed from its own export ─────────────────────────
    const harness = await startReplay({
      fixture: join(FIXTURE, 'events.jsonl'),
      speed: parseSpeed('max'),
      port: 0,
      dataDir: join(tmp, 'replay'),
      token: TEST_DAEMON_TOKEN,
    });
    let fromReplay: Map<string, Answer>;
    try {
      await harness.played();
      // The blob store is part of what "the read side of the ledger" means: a
      // payload that spilled is served through a handle, and both daemons must
      // resolve the same handle to the same bytes.
      if (existsSync(join(FIXTURE, 'blobs'))) {
        cpSync(join(FIXTURE, 'blobs'), join(harness.dataDir, 'blobs'), { recursive: true });
      }
      fromReplay = await answers(harness.origin, RUN);
    } finally {
      await harness.close();
    }

    for (const path of ROUTES(RUN)) {
      const one = fromLive.get(path);
      const other = fromReplay.get(path);
      expect(other?.status, `${path} status`).toBe(one?.status);
      expect(other?.apiVersion, `${path} X-DeFlow-Api`).toBe(one?.apiVersion);
      expect(other?.body, `${path} body`).toEqual(one?.body);
    }

    // The sweep is only meaningful if the routes actually answered: a daemon
    // that 404ed everything would "match" perfectly.
    const answered = [...fromLive.values()].filter((answer) => answer.status === 200);
    expect(answered.length).toBeGreaterThanOrEqual(6);
  });
});
