/**
 * KAR-19.9 AC4, AC5 / EPIC-19-S62 — the attached view shows the failures **as
 * they happen** and gives the terminal back.
 *
 * The operator's experience on 2026-08-13 was a command that printed nothing
 * for seven minutes and then had to be killed, which is worse than a crash — a
 * crash at least ends. Two things have to be true to replace it, and only one of
 * them can be settled by rendering a line: the lines have to arrive *while the
 * run is still retrying*, and the process has to *exit*, with the documented
 * code, because the run reached a terminal state and for no other reason.
 *
 * So the failing turn is **gated**: the framing runner throws immediately on the
 * first two attempts and then blocks inside the third, holding the run open
 * while this spec looks. "Before the last attempt finished" therefore means
 * something — the assertion is made with the daemon provably still inside the
 * turn and no ending in the ledger, so a CLI that buffered its transcript would
 * hang here rather than pass. The same shape, and for the same reason, as
 * `./run-output-live.test.ts`'s two-chunk gate.
 *
 * The exit is asserted on the **process**, not on a promise. A timeout on `run`
 * would make this file pass and would break every legitimate multi-hour run,
 * which is the whole product; `--no-wait` is not used anywhere below, because
 * this run is not waiting on a human — it is waiting on nothing.
 *
 * Verifies: EPIC-19-S62 · KAR-19.9 AC4, AC5 · test plan #4, #5
 */
import type { RunId } from '@DeFlow/core';
import { DEFAULT_RETRY_POLICY, NodeFailureError, RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { readRange } from '@DeFlow/ledger';
import { it, makeRepo } from '@DeFlow/testkit';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { api, spawnRun, until } from './support/cli-process.ts';

let booted: Booted | undefined;
let release = (): void => undefined;

afterEach(async () => {
  release();
  await booted?.shutdown();
  booted = undefined;
});

/** The ESC byte that must never reach a `--json` pipe. */
const ESC = '';

/**
 * How long a wait for the daemon to get somewhere is given.
 *
 * `until`'s own default is 30 s, which is comfortable for this spec alone — the
 * policy's two full-jitter backoffs are bounded by `base * 2^attempt`, so ~6 s
 * of waiting at worst — and too tight when the whole integration project runs
 * and several files are each booting a daemon, spawning a real CLI and driving
 * real git on the same machine. Raised rather than left to flake, because a
 * spec that goes red on a loaded CI box teaches the next reader to re-run it
 * rather than to read it.
 *
 * This buys patience, not leniency: every assertion below is unchanged, and a
 * run that never reaches its last attempt still fails here rather than passing
 * slowly.
 */
const REACHED_MS = 90_000;

/** The vendor failure the reported run actually produced, typed. */
const vendorFailure = (): NodeFailureError =>
  new NodeFailureError('claude exited 1: Invalid session ID', {
    reason: 'agent.nonzero-exit',
    class: 'transient',
    detail: { exitCode: 1, stderr: 'Invalid session ID: framing' },
  });

interface Watching {
  readonly runId: RunId;
  readonly out: string;
  readonly fd: number;
  readonly cli: ReturnType<typeof spawnRun>;
  /** How many framing turns the daemon has started. */
  readonly attempts: () => number;
}

/** Every event kind in the run's stream, in `seq` order. */
function kindsOf(runId: RunId): readonly string[] {
  const db = booted?.db;
  return db === undefined ? [] : readRange(db, runId, 0, 200).events.map((event) => event.kind);
}

/**
 * A daemon whose framing turn fails every time, a real submission on it, and a
 * spawned `DeFlow run --attach` watching.
 *
 * The last attempt blocks on a gate this spec holds; `release()` lets it throw
 * and the run then ends.
 */
async function watching(tmp: string, args: readonly string[]): Promise<Watching> {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });

  let attempts = 0;
  const held = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });

  booted = await boot({
    dataDir,
    port: 0,
    dev: false,
    tickIntervalMs: 20,
    runFraming: async () => {
      attempts += 1;
      // The ceiling's own last attempt is held open, so the assertion about
      // *when* the earlier lines were visible is made while the run is
      // demonstrably unfinished rather than after the fact.
      if (attempts >= DEFAULT_RETRY_POLICY.maxAttempts) await held;
      throw vendorFailure();
    },
  });

  const created = (await (
    await api(dataDir, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { kind: 'text', text: 'Add a health endpoint' },
        cwd: repo.dir,
        permission: 'read',
      }),
    })
  ).json()) as { runId?: string };
  const runId = RunIdSchema.parse(created.runId);

  const out = join(tmp, 'out.log');
  const fd = openSync(out, 'w');
  const cli = spawnRun({
    // No `--no-wait` anywhere: this run is not waiting on a human.
    dataDir,
    cwd: repo.dir,
    args: [...args, '--attach', runId],
    stdoutFd: fd,
  });

  return { runId, out, fd, cli, attempts: () => attempts };
}

suite('EPIC-19-S62 — the failures are on the terminal while the run retries (AC4)', () => {
  it('prints a line per attempt, naming node, attempt and reason, before the run ends', async ({
    tmp,
  }) => {
    const w = await watching(tmp, []);
    try {
      // The daemon reaches the gated last attempt and stops there, so from now
      // on the run cannot end and the window this asserts in cannot close.
      await until(
        'the daemon reached its last attempt',
        () => (w.attempts() === DEFAULT_RETRY_POLICY.maxAttempts ? true : null),
        REACHED_MS,
      );
      await until(
        'the first two attempts reached the terminal',
        () => {
          const text = readFileSync(w.out, 'utf8');
          return text.includes('attempt 1 of 3') && text.includes('attempt 2 of 3') ? text : null;
        },
        REACHED_MS,
      );

      // The instant that matters. The daemon is inside the third turn, the run
      // has not ended, and the operator can already read what is wrong.
      const transcript = readFileSync(w.out, 'utf8');
      expect(kindsOf(w.runId)).not.toContain('run.aborted');
      expect(transcript).toContain('framing');
      expect(transcript).toContain('agent.nonzero-exit');
      // In order, and one line each — never a summary at the end.
      expect(transcript.indexOf('attempt 1 of 3')).toBeLessThan(
        transcript.indexOf('attempt 2 of 3'),
      );

      release();

      // AC5 — the process exits, and because the run reached a terminal state.
      const exit = await w.cli.exited;
      expect(exit.code).toBe(1);
      expect(exit.signal).toBeNull();
      expect(kindsOf(w.runId)).toContain('run.aborted');

      const final = readFileSync(w.out, 'utf8');
      expect(final).toContain('attempt 3 of 3');
      // The verdict names the node and the typed reason — `classifyRun`'s one
      // sentence, and the only derivation of the code beside it. Read with the
      // wrapping normalised, because a narrow terminal breaks the sentence
      // under itself (KAR-18.9 AC4) and that is a layout decision, not this
      // story's.
      const unwrapped = final.replaceAll(/\s+/g, ' ');
      expect(unwrapped).toContain('aborted — node framing failed (agent.nonzero-exit)');
    } finally {
      closeSync(w.fd);
      release();
      if (w.cli.child.exitCode === null) w.cli.child.kill('SIGKILL');
    }
  }, 150_000);

  it('says the same thing as NDJSON with no ANSI, and still exits 1', async ({ tmp }) => {
    const w = await watching(tmp, ['--json']);
    try {
      await until(
        'two failures reached the pipe',
        () => {
          const lines = readFileSync(w.out, 'utf8').split('\n').filter(Boolean);
          return lines.filter((line) => line.includes('"node.failed"')).length >= 2 ? lines : null;
        },
        REACHED_MS,
      );

      release();
      const exit = await w.cli.exited;
      expect(exit.code).toBe(1);

      const lines = readFileSync(w.out, 'utf8').split('\n').filter(Boolean);
      expect(lines.join('\n')).not.toContain(ESC);

      const objects = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const failures = objects.filter((object) => object.kind === 'node.failed');
      expect(failures).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts);

      const payloads = failures.map(
        (object) =>
          object.payload as {
            node: string;
            attempt: number;
            maxAttempts?: number;
            failure: { reason: string };
          },
      );
      expect(payloads.map((payload) => payload.node)).toEqual(['framing', 'framing', 'framing']);
      expect(payloads.map((payload) => payload.attempt)).toEqual([0, 1, 2]);
      expect(payloads.map((payload) => payload.maxAttempts)).toEqual([3, 3, 3]);
      for (const payload of payloads) expect(payload.failure.reason).toBe('agent.nonzero-exit');

      // The verdict is on stderr as its own object, so every line of stdout
      // still parses as one event (KAR-18.3 AC7).
      const verdict = w.cli
        .stderr()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; exitCode: number; reason: string })
        .find((object) => object.kind === 'DeFlow.cli.verdict');
      expect(verdict?.exitCode).toBe(1);
      expect(verdict?.reason).toContain('agent.nonzero-exit');
    } finally {
      closeSync(w.fd);
      release();
      if (w.cli.child.exitCode === null) w.cli.child.kill('SIGKILL');
    }
  }, 150_000);
});
