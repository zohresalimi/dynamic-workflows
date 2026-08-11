/**
 * KAR-18.3 AC5 / EPIC-18-S22 — the stream drops mid-run, and a Node client has
 * no `Last-Event-ID`.
 *
 * The fixture is `crash-resume-seq-gap`, a ledger a real `kill -9` produced:
 * its seqs go 4, 5, **7**, 8, 11, because a rolled-back transaction burned 6
 * and the ones between 8 and 11. That is what makes it the right fixture for
 * this scenario rather than a hand-written one — the contract being asserted is
 * *"resume from strictly greater than `seq`"*, and a client that expected
 * `seq + 1` would report data loss on a perfectly healthy log.
 *
 * The socket is dropped for real (`closeAllConnections`), the reconnect is
 * observed for real (a second listener on the same `http.Server` records every
 * request line), and the transcript is the CLI's own rendered output rather
 * than a callback count, because "the rendered transcript contains every event
 * exactly once" is a claim about what the operator sees.
 *
 * Verifies: EPIC-18-S22 · AC5 · test plan #5
 */
import type { RunId } from '@DeFlow/core';
import { writeDaemonFile } from '@DeFlow/daemon';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { copyFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { runRun } from '../../src/run/run.ts';
import { EPOCH, type ServedDaemon, serveDaemon, T0 } from './support/daemon.ts';

/** The fixture a real `kill -9` produced — see the daemon's build script. */
const FIXTURE_DB = fileURLToPath(
  new URL('../../../../test/fixtures/runs/crash-resume-seq-gap/ledger.db', import.meta.url),
);
const FIXTURE_RUN = 'run_20260810T101500Z_c4a5b1' as RunId;
/** 6, 9 and 10 are missing, and that is what a healthy crashed ledger looks like. */
const FIXTURE_SEQS = [4, 5, 7, 8, 11];

let served: ServedDaemon | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const progress = (message: string): EventDraft =>
  ({
    runId: FIXTURE_RUN,
    ts: T0,
    kind: 'node.progress',
    v: 1,
    epoch: EPOCH,
    payload: { node: 'impl', attempt: 1, phase: 'running', message },
  }) as EventDraft;

const ended = (): EventDraft =>
  ({
    runId: FIXTURE_RUN,
    ts: T0,
    kind: 'run.completed',
    v: 1,
    epoch: EPOCH,
    payload: { outcome: 'succeeded', criteriaSatisfied: [] },
  }) as EventDraft;

suite('EPIC-18-S22 — resume by explicit cursor, gap and all (AC5)', () => {
  it('reconnects with ?since=<lastSeq> and renders every event exactly once', async ({ tmp }) => {
    copyFileSync(FIXTURE_DB, join(tmp, 'ledger.db'));
    served = await serveDaemon(tmp);
    const port = Number(new URL(served.baseUrl).port);
    // `DeFlow run` finds a daemon the way every other client does: the file
    // `DeFlow up` writes. `serveDaemon` is only the HTTP half, so the spec
    // writes the handoff the CLI reads.
    writeDaemonFile(tmp, {
      pid: process.pid,
      port,
      token: TEST_DAEMON_TOKEN,
      startedAt: T0,
    });

    // Every request line this daemon serves, including the reconnects.
    const requests: string[] = [];
    served.http.on('request', (request: IncomingMessage) => {
      requests.push(request.url ?? '');
    });

    const lines: string[] = [];
    const pending = runRun({
      argv: ['--json', '--attach', FIXTURE_RUN],
      cwd: tmp,
      env: { ...process.env, DeFlow_DATA_DIR: tmp },
      stdout: (chunk) => lines.push(chunk),
      stderr: () => undefined,
      isTty: () => false,
    });

    const seqs = (): number[] =>
      lines
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { seq: number }).seq);

    // Everything the fixture holds, hydrated before the stream is opened.
    await expect.poll(() => seqs().length, { timeout: 15_000 }).toBe(FIXTURE_SEQS.length);
    expect(seqs()).toEqual(FIXTURE_SEQS);

    // The socket dies mid-run, exactly the way a laptop lid does.
    served.http.closeAllConnections();

    const live = appendEvents(served.db, [progress('after the drop'), ended()]);
    await expect
      .poll(() => seqs().length, { timeout: 20_000 })
      .toBe(FIXTURE_SEQS.length + live.length);

    expect(await pending).toBe(0);

    // Exactly once, no gap and no duplicate — including across 6, 9 and 10.
    expect(seqs()).toEqual([...FIXTURE_SEQS, ...live]);
    expect(new Set(seqs()).size).toBe(seqs().length);

    // The reconnect carried the cursor, and it carried it as `?since=`: there
    // is no `Last-Event-ID` anywhere in a terminal to carry it instead.
    const streamed = requests.filter((url) => url.startsWith('/api/stream'));
    expect(streamed.length).toBeGreaterThan(1);
    expect(streamed.at(-1)).toContain(`since=${FIXTURE_SEQS.at(-1)}`);
    // …and it asked for *strictly greater than* 11, never for 12 specifically.
    expect(streamed.at(-1)).not.toContain('since=12');
  });
});
