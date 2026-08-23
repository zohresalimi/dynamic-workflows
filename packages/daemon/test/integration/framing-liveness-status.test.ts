/**
 * KAR-27.3 AC1 — a run whose framing turn is in flight says so, on every
 * surface, and still says so after a restart.
 *
 * **The defect this closes.** On 2026-08-23 the workflow view said `submitted —
 * waiting to be framed` for the whole of an eight-minute framing turn. The
 * `provider.session_opened` was in the ledger; nothing read it. AC1's three
 * clauses are all about *where the answer comes from*: derived from the ledger,
 * so it survives a restart, and produced once, so the UI and `deflow status`
 * cannot disagree.
 *
 * Integration, over a booted daemon and a file-backed ledger, because the
 * restart clause is exactly what a unit test over `runStatusLabel` cannot
 * reach: a label held in the daemon's memory passes that test and fails this
 * one.
 *
 * Verifies: EPIC-27-S15, EPIC-27-S16 · KAR-27.3 AC1
 */
import type { RunId } from '@DeFlow/core';
import { runStatusLabel } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger, replayRun } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';

const fetch = authorizedFetch();

const RUN = 'run_20260823T104141Z_e9eac2' as RunId;
const T0 = 1_787_000_000_000;
/** The instant the session row carries, and therefore the one the label reads. */
const OPENED_AT = T0 + 5_000;

interface RunListEntry {
  readonly runId: string;
  readonly status: string;
  readonly label: string;
}

const submitted = (): EventDraft =>
  ({
    runId: RUN,
    ts: T0,
    kind: 'task.submitted',
    v: 1,
    epoch: 1,
    payload: {
      sha256: 'a'.repeat(64),
      raw: 'Make a run that is framing look alive',
      provenance: { kind: 'text' as const, by: 'ui' as const, submittedAt: T0 },
    },
  }) as EventDraft;

const sessionOpened = (attempt: number, ts: number): EventDraft =>
  ({
    runId: RUN,
    ts,
    kind: 'provider.session_opened',
    v: 1,
    epoch: 1,
    nodeId: 'framing',
    attempt,
    payload: {
      node: 'framing',
      attempt,
      provider: 'claude',
      session: { id: `9d1f0f2a-0000-4000-8000-00000000000${attempt}`, origin: 'minted' },
    },
  }) as EventDraft;

const framingFailed = (attempt: number, ts: number): EventDraft =>
  ({
    runId: RUN,
    ts,
    kind: 'node.failed',
    v: 1,
    epoch: 1,
    nodeId: 'framing',
    attempt,
    payload: {
      node: 'framing',
      attempt,
      maxAttempts: 3,
      failure: {
        reason: 'agent.nonzero-exit',
        class: 'transient',
        message: 'claude exited 1 without completing the turn',
        occurredAtEvent: 1,
        attempt,
        evidence: [],
      },
    },
  }) as EventDraft;

async function seed(dataDir: string, drafts: readonly EventDraft[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [submitted(), ...drafts]);
  } finally {
    db.close();
  }
}

async function bootAt(dataDir: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, stop: () => booted.shutdown() };
}

/** The label the API serves for `RUN`, over a freshly booted daemon. */
async function servedLabel(dataDir: string): Promise<RunListEntry | undefined> {
  const daemon = await bootAt(dataDir);
  try {
    const body = (await (await fetch(`${daemon.origin}/api/runs?limit=10`)).json()) as {
      runs: readonly RunListEntry[];
    };
    return body.runs.find((row) => row.runId === RUN);
  } finally {
    await daemon.stop();
  }
}

/** The label `deflow status` composes, from the same ledger and its own replay. */
function replayedLabel(dataDir: string): string {
  const db = openLedger(dataDir);
  try {
    return runStatusLabel(replayRun(db, RUN).state);
  } finally {
    db.close();
  }
}

const RUNNING = `framing — running · attempt 1 of 3 · since ${new Date(OPENED_AT).toISOString()}`;

suite('KAR-27.3 AC1 — an in-flight framing turn is never "waiting" (EPIC-27-S15)', () => {
  it('names the node, the attempt and the since-instant on the run list', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir, [sessionOpened(0, OPENED_AT)]);

    const row = await servedLabel(dataDir);

    // The run's *status* is still `created` — nothing has been framed. What
    // changed is what the operator is told about it.
    expect(row?.status).toBe('created');
    expect(row?.label).toBe(RUNNING);
    expect(row?.label).not.toContain('waiting to be framed');
  });

  it('renders identically on the CLI’s own replay of the same ledger', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir, [sessionOpened(0, OPENED_AT)]);

    const served = await servedLabel(dataDir);

    // AC1's "renders identically in the UI and `deflow status`": two processes,
    // two folds, one sentence — because there is one function that composes it.
    expect(replayedLabel(dataDir)).toBe(served?.label);
    expect(replayedLabel(dataDir)).toBe(RUNNING);
  });

  it('survives a restart, because it was never in the daemon’s memory', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir, [sessionOpened(0, OPENED_AT)]);

    // One daemon life reports it…
    const first = await servedLabel(dataDir);
    // …and a second, booted from nothing but the file on disk, reports the
    // same. The turn's child did not survive the restart; the fact that it was
    // opened did.
    const second = await servedLabel(dataDir);

    expect(first?.label).toBe(RUNNING);
    expect(second?.label).toBe(first?.label);
  });

  it('counts the attempt from the failures the ledger records', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir, [
      sessionOpened(0, T0 + 1_000),
      framingFailed(0, T0 + 2_000),
      sessionOpened(1, OPENED_AT),
    ]);

    const row = await servedLabel(dataDir);

    expect(row?.label).toBe(
      `framing — running · attempt 2 of 3 · since ${new Date(OPENED_AT).toISOString()}`,
    );
  });
});

suite('KAR-27.3 AC1 — "waiting to be framed" is reserved for waiting (EPIC-27-S16)', () => {
  it('says waiting for a run that has opened no session at all', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir, []);

    expect((await servedLabel(dataDir))?.label).toBe('submitted — waiting to be framed');
    expect(replayedLabel(dataDir)).toBe('submitted — waiting to be framed');
  });

  it('says waiting again once the attempt concluded and the retry is still ahead', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    await seed(dataDir, [sessionOpened(0, OPENED_AT), framingFailed(0, OPENED_AT + 1_000)]);

    expect((await servedLabel(dataDir))?.label).toBe('submitted — waiting to be framed');
    expect(replayedLabel(dataDir)).toBe('submitted — waiting to be framed');
  });
});
