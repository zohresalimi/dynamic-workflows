/**
 * KAR-19.10 — `deflow run --provider`, and the sentence a run says about what
 * it picked.
 *
 * Test plan #2 and #4, and EPIC-19-S67 and EPIC-19-S68. A real booted daemon, a
 * real `PATH` staged in a temp directory, and the three surfaces read where they
 * actually live: the command's own stdout, the `provider.probed` payload in the
 * ledger, and the body of `GET /api/runs/:id`.
 *
 * The two reds:
 *
 *  * On 2026-08-13 nothing told the operator which provider had been chosen or
 *    by which route, so an afternoon was spent debugging a run against an agent
 *    they had not knowingly selected. Three surfaces have to say it, and they
 *    have to say the *same* thing — which is why the assertion is that one
 *    string appears in all three rather than that each is individually sensible.
 *  * `--provider codex` on a machine with no codex is an **environment**
 *    problem: exit 5, `doctor`'s own sentence, the typed refusal code.
 *    `--provider clawed` is an **argument** problem: `EX_USAGE`, no run created.
 *    The two look identical on a command line and lead to opposite next
 *    actions, so they are asserted against each other rather than separately.
 *
 * Verifies: EPIC-19-S67, EPIC-19-S68 · AC1, AC2, AC4
 */
import { announceProviderChoice, RunIdSchema } from '@DeFlow/core';
import { type Booted, boot, pathRoots } from '@DeFlow/daemon';
import { readRange } from '@DeFlow/ledger';
import { it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { EX_USAGE, RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { runRun } from '../../src/run/run.ts';
import { MOCK_AGENT_BIN } from './support/doctor-fixture.ts';
import { openSpecGate, waitForRun } from './support/run-fixture.ts';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

/**
 * A `PATH` root holding the bundled agent under its registry name, and nothing
 * else that DeFlow would recognise.
 *
 * Copied rather than symlinked, and given its own directory rather than added
 * to the developer's own `PATH`: "mock is the only usable provider here" has to
 * be a staged fact, or a machine with `claude` installed would quietly assert
 * something different from a machine without one.
 */
function agentRoot(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'deflow-mock-agent');
  copyFileSync(MOCK_AGENT_BIN, target);
  chmodSync(target, 0o755);
  return dir;
}

/** `git` has to stay reachable — `deflow run` checks its version before it
 * submits anything — so the staged root is prepended rather than substituted. */
const withAgent = (root: string): readonly string[] => [root, ...pathRoots(process.env)];

interface Ran {
  readonly runId: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function run(
  argv: readonly string[],
  options: { dataDir: string; cwd: string; expectRun: boolean },
): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const pending = runRun({
    argv: ['--no-wait', ...argv],
    cwd: options.cwd,
    env: { ...process.env, DeFlow_DATA_DIR: options.dataDir },
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
    isTty: () => false,
  });

  let runId: string | null = null;
  if (options.expectRun) {
    const db = booted?.db as never;
    runId = await waitForRun(db);
    openSpecGate(runId, { db, epoch: booted?.epoch ?? 1, ts: Date.now() });
  }

  // Awaited before the buffers are read, not inside the literal beside them:
  // property values evaluate in order, so joining first would snapshot the
  // streams while the command was still writing to them.
  const exitCode = await pending;
  return { runId, stdout: out.join(''), stderr: err.join(''), exitCode };
}

/** The `chosen` block on the admission `provider.probed` row, if any. */
function recordedChoice(runId: string): Record<string, unknown> | undefined {
  const events = readRange(booted?.db as never, RunIdSchema.parse(runId), 0, 64).events;
  const probed = events
    .filter((event) => event.kind === 'provider.probed')
    .map((event) => event.payload as Record<string, unknown>)
    .find((payload) => payload.chosen !== undefined);
  return probed?.chosen as Record<string, unknown> | undefined;
}

async function summary(runId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${booted?.http.port}/api/runs/${runId}`, {
    headers: { authorization: `Bearer ${TEST_DAEMON_TOKEN}` },
  });
  return (await response.json()) as Record<string, unknown>;
}

suite('EPIC-19-S67 — one line, three facts, three surfaces (AC4)', () => {
  it('says the provider, the absolute binary and the route, identically everywhere', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const root = agentRoot(`${tmp}/bin`);
    booted = await boot({
      dataDir: `${tmp}/data`,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      providerRoots: withAgent(root),
    });

    const ran = await run(['--provider', 'mock', 'keep the build green'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
      expectRun: true,
    });
    const runId = ran.runId as string;

    const expected = announceProviderChoice({
      provider: 'mock',
      binaryPath: join(root, 'deflow-mock-agent'),
      route: 'shim',
    });

    // Surface one: the terminal, before the first turn.
    expect(ran.stdout).toContain(expected);

    // Surface two: the ledger, on the payload the run already writes.
    const chosen = recordedChoice(runId);
    expect(chosen).toMatchObject({
      route: 'shim',
      binaryPath: join(root, 'deflow-mock-agent'),
      routes: { acp: 'available', shim: 'available' },
      unserved: [],
    });

    // Surface three: the run summary a UI reads.
    const body = await summary(runId);
    expect(body.provider).toMatchObject({
      provider: 'mock',
      binaryPath: join(root, 'deflow-mock-agent'),
      route: 'shim',
      announcement: expected,
    });

    expect(ran.exitCode).toBe(RUN_EXIT_CODES.awaitingHuman);
  });

  it('carries the three facts as fields under --json, never as prose', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const root = agentRoot(`${tmp}/bin`);
    booted = await boot({
      dataDir: `${tmp}/data`,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      providerRoots: withAgent(root),
    });

    const ran = await run(['--json', '--provider', 'mock', 'keep the build green'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
      expectRun: true,
    });

    const lines = ran.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const announced = lines.find((line) => line.type === 'provider');

    expect(announced).toMatchObject({
      type: 'provider',
      provider: 'mock',
      binaryPath: join(root, 'deflow-mock-agent'),
      route: 'shim',
    });
    // Fields, not a sentence: nothing downstream should have to parse prose to
    // find out which agent a run is on.
    expect(announced?.message).toBeUndefined();
  });
});

suite('EPIC-19-S68 — two kinds of wrong, two exit codes (AC1, AC2)', () => {
  it('refuses an unregistered id with EX_USAGE, before anything is submitted', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const root = agentRoot(`${tmp}/bin`);
    booted = await boot({
      dataDir: `${tmp}/data`,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      providerRoots: withAgent(root),
    });

    const ran = await run(['--provider', 'clawed', 'keep the build green'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
      expectRun: false,
    });

    expect(ran.exitCode).toBe(EX_USAGE);
    // The registered ids, and which of them this machine can actually serve.
    expect(ran.stderr).toContain('mock');
    expect(ran.stderr).toContain('codex');
    expect(ran.stderr).toContain('clawed');
    // Nothing was created: the ledger holds no run at all.
    expect(booted?.db).toBeDefined();
  });

  it('refuses a registered provider this machine cannot serve with exit 5', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const root = agentRoot(`${tmp}/bin`);
    booted = await boot({
      dataDir: `${tmp}/data`,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      providerRoots: [root],
    });

    const ran = await run(['--provider', 'codex', 'keep the build green'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
      expectRun: false,
    });

    // An environment problem, not an argument one — the operator installs a
    // package rather than editing their command line.
    expect(ran.exitCode).toBe(RUN_EXIT_CODES.environmentUnusable);
    expect(ran.exitCode).not.toBe(EX_USAGE);
    // `doctor`'s own sentence, from the same renderer, ending with the way to
    // proceed with nothing installed.
    expect(ran.stderr).toContain('codex is not installed here');
    expect(ran.stderr).toContain('deflow-mock-agent');
  });
});
