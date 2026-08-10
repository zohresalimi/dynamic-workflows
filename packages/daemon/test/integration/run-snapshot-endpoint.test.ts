/**
 * KAR-15.7 — `GET /api/runs/:id/snapshot?seq=N` over a real socket
 * (docs/11-api-and-realtime.md §7.3).
 *
 * Integration for the reason `./run-rollup-api.test.ts` gives for the run
 * summary: proving the projection composes correctly is not the same as
 * proving the scrubber can reach it. Every assertion below is against JSON
 * that came back over `fetch` from a DeFlowd bound to an ephemeral port,
 * reading through the same read-only connection production uses — and the
 * gap scenario runs against the real `crash-resume-seq-gap` fixture
 * (docs/delivery/flows/EPIC-15-daemon-api-flows.md EPIC-15-S46), a ledger a
 * real `kill -9` left behind, rather than one constructed by hand.
 *
 * Verifies: EPIC-15-S45, EPIC-15-S46 · AC1, AC2, AC3, AC7, AC8 ·
 * test plan #5 (as a golden-snapshot stand-in for the not-yet-built
 * `DeFlow replay`/`three-patches` fixture — see the epic's own out-of-scope
 * note that EPIC-16/17/18 are downstream of this one)
 */
import type { RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { appendEvents, type Db, type EventDraft } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import {
  CRASH_RESUME_FIXTURE_DIR,
  CRASH_RESUME_RUN,
  CRASH_RESUME_SEQS,
} from '../../scripts/build-crash-resume-fixture.ts';
import { EPOCH, fetch, type Served, serve, T0 } from './support/stream-daemon.ts';

const RUN: RunId = RunIdSchema.parse('run_20260810T090000Z_af1507');
const NODE = NodeIdSchema.parse('n-impl');

const draft = (kind: string, payload: unknown, over: Partial<EventDraft> = {}): EventDraft =>
  ({ runId: RUN, ts: T0, kind, v: 1, epoch: EPOCH, payload, ...over }) as EventDraft;

/**
 * Three events whose third one moves run-level status — the same "not
 * vacuous" property `run-snapshot.test.ts` proves at the ledger level, proven
 * again here across a real socket: seq 2's snapshot must not carry seq 3's
 * `paused`.
 */
function seedThreeSteps(db: Db): void {
  appendEvents(db, [
    draft('node.scheduled', { node: NODE, provider: 'claude', permission: 'read' }),
    draft(
      'node.started',
      {
        node: NODE,
        attempt: 1,
        ikey: `${RUN}/${NODE}/1/0`,
        binary: { path: '/opt/claude/bin/claude', version: '0.64.1', sha256: 'd'.repeat(64) },
      },
      { nodeId: NODE, attempt: 1 },
    ),
    draft('run.paused', { by: 'user' }),
  ]);
}

interface SnapshotBody {
  readonly seq: number;
  readonly state: { readonly status: string; readonly planVersion: number };
  readonly planVersion: number;
  readonly planHash: string | null;
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('GET /api/runs/:id/snapshot — happy path (EPIC-15-S45, AC1)', () => {
  it('returns the reduced state at exactly the requested seq, echoed back', async ({ tmp }) => {
    served = await serve(tmp);
    seedThreeSteps(served.db);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/snapshot?seq=2`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SnapshotBody;

    expect(body.seq).toBe(2);
    expect(body.state.status).not.toBe('paused');
    expect(body.planVersion).toBe(body.state.planVersion);
    expect(body.planHash).toBeNull();
  });

  it("accepts seq=head and echoes the run's actual head (AC2)", async ({ tmp }) => {
    served = await serve(tmp);
    seedThreeSteps(served.db);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/snapshot?seq=head`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SnapshotBody;

    expect(body.seq).toBe(3);
    expect(body.state.status).toBe('paused');
  });

  it('a seq past this run’s own head answers the head state, not an error (AC8)', async ({
    tmp,
  }) => {
    served = await serve(tmp);
    seedThreeSteps(served.db);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/snapshot?seq=999999`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SnapshotBody;

    expect(body.seq).toBe(3);
    expect(body.state.status).toBe('paused');
  });
});

suite('GET /api/runs/:id/snapshot — a real gap (EPIC-15-S46, AC3)', () => {
  const servedCopy = (tmp: string): string => {
    copyFileSync(join(CRASH_RESUME_FIXTURE_DIR, 'ledger.db'), join(tmp, 'ledger.db'));
    return tmp;
  };

  it('a burned sequence number resolves down to the nearest committed one', async ({ tmp }) => {
    served = await serve(servedCopy(tmp));

    const response = await fetch(`${served.origin}/api/runs/${CRASH_RESUME_RUN}/snapshot?seq=6`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SnapshotBody;

    // 4, 5, 7, 8, 11 — 6 was never this run's; it belongs to the run
    // interleaved beside it.
    expect(CRASH_RESUME_SEQS).toContain(5);
    expect(CRASH_RESUME_SEQS).not.toContain(6);
    expect(body.seq).toBe(5);
  });

  it('beyond this run’s own head resolves to its head, 11', async ({ tmp }) => {
    served = await serve(servedCopy(tmp));

    const response = await fetch(
      `${served.origin}/api/runs/${CRASH_RESUME_RUN}/snapshot?seq=999999`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as SnapshotBody;

    expect(body.seq).toBe(11);
  });
});

suite('GET /api/runs/:id/snapshot — refusals', () => {
  it('a run this directory does not hold is 404 run_not_found', async ({ tmp }) => {
    served = await serve(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/snapshot?seq=head`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('run_not_found');
  });

  it('a missing seq is 400 invalid_request, never a guess', async ({ tmp }) => {
    served = await serve(tmp);
    seedThreeSteps(served.db);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/snapshot`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('a seq that is not a number and not "head" is 400 invalid_request', async ({ tmp }) => {
    served = await serve(tmp);
    seedThreeSteps(served.db);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/snapshot?seq=nope`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });
});

suite('GET /api/runs/:id/snapshot — three scrub positions (test plan #5)', () => {
  it('matches the recorded golden body at each position', async ({ tmp }) => {
    served = await serve(tmp);
    seedThreeSteps(served.db);

    const bodies: SnapshotBody[] = [];
    for (const seq of [1, 2, 3]) {
      const response = await fetch(`${served.origin}/api/runs/${RUN}/snapshot?seq=${seq}`);
      expect(response.status).toBe(200);
      bodies.push((await response.json()) as SnapshotBody);
    }

    expect(JSON.stringify(bodies, null, 2)).toMatchSnapshot();
  });
});
