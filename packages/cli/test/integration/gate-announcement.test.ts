/**
 * KAR-19.12 AC1, AC2, AC3 — a run that stops to ask says so, in the terminal
 * that is attached to it.
 *
 * A real daemon, a real socket and the real command, because the claim is about
 * what an operator sees at the moment the gate opens — not about a string a
 * renderer can produce. The gate is opened by `openSpecApprovalGate`, the same
 * shipped function the framing chain calls, for the reason
 * `./support/run-fixture.ts` gives at length.
 *
 * The regression case is precise: on 2026-08-14 the `human.requested` line
 * *was* rendered, carrying several hundred words of rendered spec, and nothing
 * in it said the run had stopped or named the four options. So the assertions
 * are the sentence, the option ids and the two ways to answer.
 *
 * Verifies: EPIC-19-S79, EPIC-19-S81 · KAR-19.12 AC1, AC2, AC3 · test plan #2
 */
import { RunIdSchema, SPEC_APPROVAL_OPTIONS, SPEC_GATE_NODE } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { runRun } from '../../src/run/run.ts';
import { openSpecGate, waitForRun } from './support/run-fixture.ts';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

/** The ESC that must never reach a pipe. */
const ESC = '\u001B';

interface Watched {
  readonly runId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Submits a task, opens the F1.3 gate under the watching command, and returns
 * once `--no-wait` has given the terminal back.
 */
async function watchToGate(argv: readonly string[], tmp: string): Promise<Watched> {
  const repo = await makeRepo({ dir: `${tmp}/repo` });
  const dataDir = `${tmp}/data`;
  booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });

  const out: string[] = [];
  const err: string[] = [];
  const pending = runRun({
    argv: ['--no-wait', 'migrate the button to v3', ...argv],
    cwd: repo.dir,
    env: { ...process.env, DeFlow_DATA_DIR: dataDir },
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
    isTty: () => false,
  });

  const db = booted.db;
  const runId = await waitForRun(db);
  openSpecGate(RunIdSchema.parse(runId), { db, epoch: booted.epoch, ts: Date.now() });

  const exitCode = await pending;
  return { runId, stdout: out.join(''), stderr: err.join(''), exitCode };
}

suite('EPIC-19-S79 — the block names the gate, the wait and the options (AC1)', () => {
  it('says the run is waiting, and lists every option by id and label', async ({ tmp }) => {
    const watched = await watchToGate([], tmp);
    // Read with the wrapping normalised: a narrow terminal breaks a detail
    // under itself (KAR-18.9 AC4), which is a layout decision and not this
    // story's.
    const transcript = watched.stdout.replaceAll(/\s+/g, ' ');

    expect(transcript).toContain(SPEC_GATE_NODE);
    expect(transcript.toLowerCase()).toContain('waiting for you');
    for (const option of SPEC_APPROVAL_OPTIONS) {
      expect(transcript).toContain(option.id);
      expect(transcript).toContain(option.label);
    }
  });

  it('says how to answer it, by command and by URL (AC2)', async ({ tmp }) => {
    const watched = await watchToGate([], tmp);
    const transcript = watched.stdout.replaceAll(/\s+/g, ' ');

    expect(transcript).toContain(
      `deflow answer ${watched.runId} --gate ${SPEC_GATE_NODE} --option approve`,
    );
    expect(transcript).toContain(`/runs/${watched.runId}`);
  });
});

suite('EPIC-19-S81 — the contracts CI depends on are unchanged (AC3)', () => {
  it('still exits 4 under --no-wait, having printed the block first', async ({ tmp }) => {
    const watched = await watchToGate([], tmp);

    expect(watched.exitCode).toBe(RUN_EXIT_CODES.awaitingHuman);
    // Printed *before* the process gave up the terminal, which is the whole
    // point: a CI log that exits 4 and says nothing is the same silence.
    expect(watched.stdout).toContain(SPEC_GATE_NODE);
    expect(watched.stdout).not.toContain(ESC);
  });

  it('emits exactly one NDJSON object for the gate under --json', async ({ tmp }) => {
    const watched = await watchToGate(['--json'], tmp);

    // stdout stays a stream of events and nothing else — every line still
    // parses, and none of them is the announcement.
    const stdoutLines = watched.stdout.split('\n').filter(Boolean);
    for (const line of stdoutLines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(watched.stdout).not.toContain('DeFlow.cli.gate');

    // The announcement is on stderr, beside the verdict, one object per line.
    const lines = watched.stderr.split('\n').filter(Boolean);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(`${watched.stdout}${watched.stderr}`).not.toContain(ESC);

    const gates = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((object) => object.kind === 'DeFlow.cli.gate');
    expect(gates).toHaveLength(1);

    const gate = gates[0] as {
      node: string;
      options: readonly { id: string }[];
      answer: string;
      url: string;
    };
    expect(gate.node).toBe(SPEC_GATE_NODE);
    expect(gate.options.map((option) => option.id)).toEqual(
      SPEC_APPROVAL_OPTIONS.map((option) => option.id),
    );
    expect(gate.answer).toContain(`--gate ${SPEC_GATE_NODE}`);
    expect(gate.url).toContain(`/runs/${watched.runId}`);
  });
});
