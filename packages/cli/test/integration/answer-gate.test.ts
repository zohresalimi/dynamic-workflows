/**
 * KAR-19.12 AC4, AC7 — the gate is answerable from a terminal, and an answer
 * from anywhere lands in the attached session.
 *
 * `approveSpec` has been a client of `POST /api/runs/:id/spec/approve` since
 * KAR-10.3, whose own doc comment describes it as *"`deflow approve <runId>`"*
 * — a command that was never registered in `bin.ts`. Until this story the only
 * route to the F1.3 gate was a browser, or a hand-written HTTP request carrying
 * a bearer token dug out of the daemon's own token file.
 *
 * A real daemon, a real socket and the real command throughout: the assertion
 * that matters is what the *ledger* holds afterwards, because a command that
 * printed "approved" and appended nothing would satisfy a transcript check.
 *
 * Verifies: EPIC-19-S80, EPIC-19-S83 · KAR-19.12 AC4, AC7 · test plan #4, #5, #6
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema, SPEC_GATE_NODE } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { readRange } from '@DeFlow/ledger';
import { it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { runAnswer } from '../../src/answer.ts';
import { runRun } from '../../src/run/run.ts';
import { framedRun, waitForRun } from './support/run-fixture.ts';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

interface AtTheGate {
  readonly runId: RunId;
  readonly dataDir: string;
  readonly cwd: string;
}

/** Every event kind in the run's stream, in `seq` order. */
function kindsOf(runId: RunId): readonly string[] {
  const db = booted?.db;
  return db === undefined ? [] : readRange(db, runId, 0, 200).events.map((event) => event.kind);
}

/**
 * A real daemon holding a real run at an open F1.3 gate.
 *
 * The submission goes through `deflow run --no-wait`, so the run is created the
 * way an operator creates one; the gate is opened by the same shipped function
 * the framing chain calls.
 */
async function atTheGate(tmp: string): Promise<AtTheGate> {
  const repo = await makeRepo({ dir: `${tmp}/repo` });
  const dataDir = `${tmp}/data`;
  booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });

  const pending = runRun({
    argv: ['--no-wait', 'migrate the button to v3'],
    cwd: repo.dir,
    env: { ...process.env, DeFlow_DATA_DIR: dataDir },
    stdout: () => undefined,
    stderr: () => undefined,
    isTty: () => false,
  });

  const db = booted.db;
  const runId = RunIdSchema.parse(await waitForRun(db));
  framedRun(runId, { db, epoch: booted.epoch, ts: Date.now(), cwd: repo.dir });
  await pending;

  return { runId, dataDir, cwd: repo.dir };
}

const answer = (at: AtTheGate, argv: readonly string[]) =>
  runAnswer({
    argv: [at.runId, ...argv],
    env: { ...process.env, DeFlow_DATA_DIR: at.dataDir },
  });

suite('EPIC-19-S80 — deflow answer, with no browser and no token (AC4)', () => {
  it('approves the F1.3 gate, and the daemon appends the transaction', async ({ tmp }) => {
    const at = await atTheGate(tmp);

    const result = await answer(at, ['--gate', SPEC_GATE_NODE, '--option', 'approve']);

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(at.runId);
    // The ledger, not the transcript: the daemon owns the transaction, and this
    // command is a client of it (KAR-10.3).
    const kinds = kindsOf(at.runId);
    expect(kinds).toContain('human.responded');
    expect(kinds).toContain('run.spec.approved');
  });

  it('refuses an option the gate does not offer, in the daemon’s own words', async ({ tmp }) => {
    const at = await atTheGate(tmp);

    const result = await answer(at, ['--gate', SPEC_GATE_NODE, '--option', 'demolish']);

    expect(result.exitCode).not.toBe(0);
    // The four the F1.3 gate actually offers, named by whoever owns the rule.
    expect(result.stderr).toContain('approve');
    expect(kindsOf(at.runId)).not.toContain('human.responded');
  });

  it('refuses a run the daemon does not have, without appending anything', async ({ tmp }) => {
    const at = await atTheGate(tmp);

    const result = await runAnswer({
      argv: ['run_20260101T000000Z_000000', '--gate', SPEC_GATE_NODE, '--option', 'approve'],
      env: { ...process.env, DeFlow_DATA_DIR: at.dataDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(kindsOf(at.runId)).not.toContain('human.responded');
  });
});

suite('EPIC-19-S83 — an answer from elsewhere lands in the attached session (AC7)', () => {
  it('prints the answered line without a reconnect, while still attached', async ({ tmp }) => {
    const at = await atTheGate(tmp);

    // Attached again, this time *waiting*: no `--no-wait`, so the command is
    // still following when the answer arrives from the other terminal.
    const out: string[] = [];
    const watching = runRun({
      argv: ['--attach', at.runId],
      cwd: at.cwd,
      env: { ...process.env, DeFlow_DATA_DIR: at.dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: () => undefined,
      isTty: () => false,
    });

    await until('the follower reached the gate', () =>
      out.join('').includes(SPEC_GATE_NODE) ? true : null,
    );

    // Answered by something that is not the follower — the UI, or a second
    // terminal. This is the whole scenario.
    const answered = await answer(at, ['--gate', SPEC_GATE_NODE, '--option', 'abandon']);
    expect(answered.exitCode).toBe(0);

    const exitCode = await watching;
    const transcript = out.join('').replaceAll(/\s+/g, ' ');
    expect(transcript).toContain(`${SPEC_GATE_NODE} answered`);
    expect(transcript).toContain('abandon');
    // The run then reached its own ending in the same attached process.
    expect(exitCode).not.toBeNull();
    expect(kindsOf(at.runId)).toContain('human.responded');
  });
});

/** Polls until `read` answers, or fails with a sentence naming what was waited
 * for — never a bare timeout. */
async function until<T>(what: string, read: () => T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${what}: not within ${String(timeoutMs)} ms`);
}
