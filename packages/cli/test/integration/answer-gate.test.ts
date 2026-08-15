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
import type { Event, RunId, RunState } from '@DeFlow/core';
import { initialRunState, RunIdSchema, SPEC_GATE_NODE } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { readRange, replayRun } from '@DeFlow/ledger';
import { it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { runAnswer } from '../../src/answer.ts';
import { runRun } from '../../src/run/run.ts';
import {
  framedRun,
  HUMAN_NODE,
  HUMAN_NODE_OPTIONS,
  suspendedOnHumanNode,
  waitForRun,
} from './support/run-fixture.ts';

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

/** The run's whole stream, in `seq` order. */
function eventsOf(runId: RunId): readonly Event[] {
  const db = booted?.db;
  return db === undefined ? [] : readRange(db, runId, 0, 200).events;
}

/** Every event kind in the run's stream, in `seq` order. */
function kindsOf(runId: RunId): readonly string[] {
  return eventsOf(runId).map((event) => event.kind);
}

/** The run as the reducer folds it — the projection every surface reads. */
function stateOf(runId: RunId): RunState {
  const db = booted?.db;
  return db === undefined ? initialRunState() : replayRun(db, runId).state;
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

/* -------------------------------------------------------------------------- *
 * the other routing path: a gate the plan declared
 * -------------------------------------------------------------------------- */

const PLAN_GATE_RUN: RunId = RunIdSchema.parse('run_20260814T101500Z_0b0b0b');

/**
 * A real daemon holding a run suspended on a plan-level `human` node.
 *
 * Not the F1.3 gate, which is the whole point: AC4 names **two** routing paths
 * and every other spec in this file exercises the spec one. This run's gate is
 * answered through `POST /api/runs/:id/nodes/:nodeId/respond`, whose refusals
 * are `planHumanResponse`'s rather than `SPEC_DECISIONS`'.
 */
async function atThePlanGate(tmp: string): Promise<AtTheGate> {
  const repo = await makeRepo({ dir: `${tmp}/repo` });
  const dataDir = `${tmp}/data`;
  booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });

  await suspendedOnHumanNode({
    db: booted.db,
    epoch: booted.epoch,
    ts: Date.now(),
    cwd: repo.dir,
    runId: PLAN_GATE_RUN,
  });

  return { runId: PLAN_GATE_RUN, dataDir, cwd: repo.dir };
}

/** Wraps the real `fetch` to record where the command sent the answer. Every
 * request still goes over the real socket to the real daemon — what is recorded
 * is the URL, which is the routing decision AC4 is about. */
function recordingFetch(seen: string[]): typeof globalThis.fetch {
  return (input, init) => {
    seen.push(typeof input === 'string' ? input : String(input));
    return globalThis.fetch(input, init);
  };
}

suite('EPIC-19-S80 — a gate on a plan node (AC4)', () => {
  it('posts the answer to nodes/:nodeId/respond, and the node resumes on the attempt it was suspended on', async ({
    tmp,
  }) => {
    const at = await atThePlanGate(tmp);
    const suspended = eventsOf(at.runId).find((event) => event.kind === 'node.suspended');
    // Read before the answer, and off the node the scheduler actually suspended
    // rather than a number this spec chose.
    expect(suspended?.nodeId).toBe(HUMAN_NODE);
    const attempt = suspended?.attempt;
    expect(attempt).toBeTypeOf('number');
    expect(stateOf(at.runId).nodes[HUMAN_NODE]).toMatchObject({ status: 'suspended' });

    const seen: string[] = [];
    const result = await runAnswer({
      argv: [at.runId, '--gate', HUMAN_NODE, '--option', 'continue'],
      env: { ...process.env, DeFlow_DATA_DIR: at.dataDir },
      fetch: recordingFetch(seen),
    });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    // The other of AC4's two routes. Not the four spec endpoints, which is what
    // a `route()` that had forgotten the plan-gate branch would have used.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(`/api/runs/${at.runId}/nodes/${HUMAN_NODE}/respond`);
    expect(seen[0]).not.toContain('/spec/');

    // The ledger, not the transcript: `planHumanResponse` owns what an answer
    // means, and `continue` carries the `approve` effect the plan declared.
    const responded = eventsOf(at.runId).find((event) => event.kind === 'human.responded');
    expect(responded?.payload).toMatchObject({ node: HUMAN_NODE, optionId: 'continue' });

    // The second Then clause: the answer lands on the attempt the gate was
    // opened on, so the node it completes is the one that was suspended rather
    // than a fresh attempt nothing ever started.
    const completed = eventsOf(at.runId).find((event) => event.kind === 'node.completed');
    expect(completed?.attempt).toBe(attempt);
    expect(responded?.attempt).toBe(attempt);
    expect(completed?.payload).toMatchObject({ node: HUMAN_NODE, attempt });

    // And as the projection reads it back, which is where a completion stamped
    // on the *wrong* attempt shows up: `attemptOf` takes the maximum of what it
    // has seen, so an answer applied to `attempt + 1` would leave the node
    // claiming two attempts spent on a gate that was asked once.
    expect(stateOf(at.runId).nodes[HUMAN_NODE]).toMatchObject({
      status: 'completed',
      attempt,
      attempts: (attempt ?? 0) + 1,
    });
  });

  it('refuses an option the plan gate does not offer, in the daemon’s own words', async ({
    tmp,
  }) => {
    const at = await atThePlanGate(tmp);

    const result = await runAnswer({
      argv: [at.runId, '--gate', HUMAN_NODE, '--option', 'maybe'],
      env: { ...process.env, DeFlow_DATA_DIR: at.dataDir },
    });

    expect(result.exitCode).not.toBe(0);
    // `planHumanResponse`'s sentence, naming what *this* gate offers — the CLI
    // holds no second validator for a plan gate, so the two cannot drift.
    for (const option of HUMAN_NODE_OPTIONS) {
      expect(result.stderr).toContain(`'${option.id}'`);
    }
    expect(result.stderr).toContain('unknown_option');
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
