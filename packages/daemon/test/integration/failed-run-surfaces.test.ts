/**
 * KAR-19.9 AC3, AC6 / EPIC-19-S58 — a run that gave up says so on every surface
 * that can be asked, and at the same head sequence.
 *
 * The reported run of 2026-08-13 could not have: its ledger held
 * `provider.probed`, `provider.probed`, `task.submitted` and nothing else while
 * the daemon threw the same error every thirty seconds, so `GET /api/runs/:id`
 * answered `created` for ever and the web run list showed a live run nobody was
 * running. Bounding the retry is only two thirds of the fix — the third is that
 * the *ending* has to be readable, with its reason, by the tools a waiting human
 * actually has open.
 *
 * A real booted daemon rather than a call into the driver, because the failure
 * this asserts against is a route serving a correct projection under a stale
 * status: nothing that constructs the projection itself can see it. The framing
 * runner is a port that throws, which is what a vendor CLI exiting non-zero
 * reaches this layer as (`e2e/live-chain-failure.test.ts` is the same scenario
 * with a real subprocess behind it).
 *
 * Verifies: EPIC-19-S58, EPIC-19-S59 · KAR-19.9 AC3, AC6 · test plan #6
 */
import type { NodeFailure, RunId } from '@DeFlow/core';
import { DEFAULT_RETRY_POLICY, NodeFailureError } from '@DeFlow/core';
import {
  appendEvents,
  openLedger,
  openRead,
  readRange,
  readWakes,
  scheduleWake,
} from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';
import { FRAMING_WAKE_REASON } from '../../src/intake/intake.ts';
import { FRAMING_NODE } from '../../src/spec/gate.ts';

const fetch = authorizedFetch();

const T0 = 1_755_080_000_000;
const RUN = 'run_20260813T110608Z_379fc8' as RunId;

/** The vendor failure the reported run actually produced, typed. */
const vendorFailure = (): NodeFailureError =>
  new NodeFailureError('claude exited 1: Invalid session ID', {
    reason: 'agent.nonzero-exit',
    class: 'transient',
    detail: { exitCode: 1, stderr: 'Invalid session ID: framing' },
  });

/** A run at exactly the state the reported one was in: submitted, framing wake
 * due, nothing else. */
async function seedSubmittedRun(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      {
        runId: RUN,
        ts: T0,
        kind: 'task.submitted',
        v: 1,
        epoch: 1,
        payload: {
          sha256: 'b'.repeat(64),
          raw: 'Add a health endpoint',
          provenance: { kind: 'text', by: 'cli', submittedAt: T0, cwd: '/repo' },
        },
      },
    ]);
    scheduleWake(db, { runId: RUN, nodeId: FRAMING_NODE, wakeAt: T0, reason: FRAMING_WAKE_REASON });
  } finally {
    db.close();
  }
}

interface FailureBody {
  readonly node: string;
  readonly reason: string;
  readonly class: string;
  readonly message: string;
  readonly attempts: number;
}

interface SummaryBody {
  readonly status: string;
  readonly outcome: string | null;
  readonly headSeq: number;
  readonly watermarkSeq: number;
  readonly failure?: FailureBody;
}

interface RunListBody {
  readonly runs: readonly {
    readonly runId: string;
    readonly status: string;
    readonly label: string;
  }[];
}

interface EventsBody {
  readonly events: readonly {
    readonly kind: string;
    readonly seq: number;
    readonly payload: Record<string, unknown>;
  }[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the run to end, reading the ledger the daemon is writing. */
async function waitForEnding(dataDir: string, budgetMs = 60_000): Promise<readonly string[]> {
  const deadline = Date.now() + budgetMs;
  let kinds: readonly string[] = [];
  while (Date.now() < deadline) {
    // A read connection: the daemon under test holds the one writer this
    // process is allowed, which is the invariant `LedgerAlreadyOpen` protects.
    const db = openRead(join(dataDir, 'ledger.db'));
    try {
      kinds = readRange(db, RUN, 0, 200).events.map((event) => event.kind);
    } finally {
      db.close();
    }
    if (kinds.includes('run.aborted')) return kinds;
    await sleep(100);
  }
  throw new Error(`run ${RUN} never ended; its ledger held ${kinds.join(', ')}`);
}

/** Reads an SSE response until `phrase` appears, then cancels it. */
async function readUntil(response: Response, phrase: string): Promise<string> {
  const stream = response.body;
  if (stream === null) throw new Error('the stream response carried no body');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => void reader.cancel('the frame never arrived'), 10_000);
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
      if (text.includes(phrase)) return text;
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
  }
}

suite('EPIC-19-S58 — a run that spent its attempts is failed on every surface (AC3, AC6)', () => {
  it('serves the failed status, the typed reason and the attempts in order', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seedSubmittedRun(dataDir);

    const booted = await boot({
      dataDir,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      runFraming: () => {
        throw vendorFailure();
      },
    });
    const origin = `http://127.0.0.1:${(booted.http.server.address() as AddressInfo).port}`;

    try {
      // The global topic, opened *before* the run ends — the subscription the
      // web run list holds. `run.aborted` is already one of its four members,
      // so a run that gives up reaches the list without a new topic.
      const global = await fetch(`${origin}/api/stream?runs=*&since=0`);
      const framesRead = readUntil(global, 'run.aborted');

      const kinds = await waitForEnding(dataDir);
      expect(kinds.filter((kind) => kind === 'node.failed')).toHaveLength(
        DEFAULT_RETRY_POLICY.maxAttempts,
      );
      expect(kinds.at(-1)).toBe('run.aborted');

      // AC6 — the summary the web run view and `DeFlow status` read.
      const summary = (await (await fetch(`${origin}/api/runs/${RUN}`)).json()) as SummaryBody;
      expect(summary.status).toBe('aborted');
      expect(summary.outcome).toBe('failed');
      expect(summary.failure?.node).toBe(FRAMING_NODE);
      expect(summary.failure?.reason).toBe('agent.nonzero-exit');
      expect(summary.failure?.class).toBe('transient');
      expect(summary.failure?.message).toContain('Invalid session ID');
      expect(summary.failure?.attempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);

      // …at the same head sequence the terminal event landed at: a summary a
      // tick behind is how a UI shows a live run nobody is running.
      expect(summary.watermarkSeq).toBe(summary.headSeq);

      // AC6 — the run's own view: the failed attempts, in order, each carrying
      // the ceiling it was measured against.
      const events = (await (
        await fetch(`${origin}/api/runs/${RUN}/events?since=0&limit=200`)
      ).json()) as EventsBody;
      const failures = events.events.filter((event) => event.kind === 'node.failed');
      expect(failures.map((event) => (event.payload.failure as NodeFailure).attempt)).toEqual([
        0, 1, 2,
      ]);
      expect(failures.map((event) => event.payload.maxAttempts)).toEqual([3, 3, 3]);
      expect(failures.map((event) => event.seq)).toEqual(
        [...failures.map((event) => event.seq)].toSorted((a, b) => a - b),
      );

      // AC6 — the run list, in the words every surface prints. No fourth
      // spelling: `runStatusLabel` produced this one.
      const list = (await (await fetch(`${origin}/api/runs?limit=10`)).json()) as RunListBody;
      const row = list.runs.find((entry) => entry.runId === RUN);
      expect(row?.status).toBe('aborted');
      expect(row?.label).toBe('aborted');

      // AC3 — no wake row is left due for the node, so nothing dispatches a
      // fourth turn for a run that is over.
      const db = openRead(join(dataDir, 'ledger.db'));
      try {
        expect(readWakes(db, RUN)).toEqual([]);
      } finally {
        db.close();
      }

      expect(await framesRead).toContain(RUN);
    } finally {
      await booted.shutdown();
    }
  }, 90_000);
});
