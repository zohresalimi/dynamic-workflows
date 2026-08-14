/**
 * KAR-19.9 AC3, AC5 / EPIC-19-S58 — the operator gets an answer and their
 * terminal back.
 *
 * This is the regression test for the second defect of the 2026-08-13 by-hand
 * run, and every clause below is a sentence from that afternoon inverted. The
 * framing turn failed; DeFlow retried the identical failure every ~31 s
 * indefinitely; `deflow run` printed **nothing** about any of it; the command
 * was still hanging after seven minutes and had to be killed.
 *
 * The clause with the most teeth is *"the process is no longer running"*, and it
 * is the reason this spec is `e2e` rather than `integration`: an assertion on a
 * promise cannot make it. So the binary is spawned as a real process against a
 * daemon it starts for itself, and what is asserted is the **exit**, from
 * outside.
 *
 * **The provider is scripted rather than mocked.** `deflow-mock-agent` on the
 * hermetic `PATH` is a real executable that serves the capability probe by
 * delegating to the bundled agent and refuses every *turn* with a non-zero exit
 * and a sentence on stderr — a fake binary, not a mocked module
 * (docs/14-testing-strategy.md §3). The failure the daemon classifies is
 * therefore a real child's real exit code.
 *
 * Verifies: EPIC-19-S58 · KAR-19.9 AC3, AC5 · test plan #9's e2e half
 */

import { PROVIDER_SPECS } from '@DeFlow/adapters';
import { DEFAULT_RETRY_POLICY, type RunId } from '@DeFlow/core';
import { openRead, readRange } from '@DeFlow/ledger';
import { makeRepo } from '@DeFlow/testkit';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CliProcess,
  GIT_DIR,
  MOCK_AGENT_BIN,
  makeDataDir,
  NODE_DIR,
  removeDataDir,
  sleep,
  spawnCli,
} from './support/up.ts';

let tmp = '';
const running: CliProcess[] = [];

beforeEach(async () => {
  tmp = await makeDataDir();
});

afterEach(async () => {
  for (const cli of running.splice(0)) await cli.stop();
  await stopAutostartedDaemon();
  await removeDataDir(tmp);
});

interface DaemonFile {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

function daemonFile(): DaemonFile | null {
  try {
    return JSON.parse(readFileSync(join(tmp, 'data', 'daemon.json'), 'utf8')) as DaemonFile;
  } catch {
    return null;
  }
}

/** The daemon `deflow run` started for itself, stopped — it is detached, so
 * nothing else here will take it down. */
async function stopAutostartedDaemon(): Promise<void> {
  const file = daemonFile();
  if (file === null) return;
  try {
    process.kill(file.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(file.pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
}

/**
 * A bin directory holding a `deflow-mock-agent` that **fails every turn**.
 *
 * It is a provider, not a broken `PATH` entry: the capability probe's ACP
 * handshake is served by delegating to the bundled agent beside it, so the run
 * is admitted exactly as it would be on a working machine. What it refuses is
 * the turn — the structured invocation the framing node makes — with a non-zero
 * exit and one sentence on stderr, which is what a wedged vendor CLI looks like
 * from DeFlow's side and is precisely the shape of the reported failure.
 */
function failingAgentOnly(liveLog: string): string {
  const dir = join(tmp, 'bin');
  mkdirSync(dir, { recursive: true });

  const wrapper = join(dir, PROVIDER_SPECS.mock.bin);
  writeFileSync(wrapper, failingAgentSource(MOCK_AGENT_BIN, liveLog), { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  return dir;
}

/**
 * EPIC-19-S61 scenario 2 / KAR-19.9 AC8 — the most children that existed at
 * once, from the brackets the children themselves wrote.
 *
 * The failure mode this measures is invisible on a laptop and expensive on a
 * rate-limited plan: a fix that bounds *attempts* but leaves the dispatch
 * re-entrant spawns a second child on the tick after a slow failure, so the
 * ceiling counts to three while five processes ran. Counting the ceiling
 * therefore cannot catch it, and only counting the children can.
 */
function peakConcurrentChildren(liveLog: string): { peak: number; started: number } {
  const marks = readFileSync(liveLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);

  let live = 0;
  let peak = 0;
  let started = 0;
  for (const mark of marks) {
    if (mark.startsWith('+')) {
      live += 1;
      started += 1;
      peak = Math.max(peak, live);
    } else {
      live -= 1;
    }
  }
  return { peak, started };
}

/**
 * The scripted agent, as a `#!/usr/bin/env node` script — the same shape every
 * other fake binary in `e2e/` takes, and for the same reason: `node` is the one
 * interpreter the hermetic `PATH` is guaranteed to resolve.
 */
function failingAgentSource(realAgent: string, liveLog: string): string {
  return [
    '#!/usr/bin/env node',
    '// A provider scripted to fail every turn (KAR-19.9, EPIC-19-S58, S61).',
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    "import process from 'node:process';",
    '',
    'const argv = process.argv.slice(2);',
    // The turn — the structured invocation the framing node makes. Refused
    // with a non-zero exit and one sentence on stderr, which is what a wedged
    // vendor CLI looks like from DeFlow's side.
    "if (argv.includes('--return-schema')) {",
    // EPIC-19-S61 scenario 2 — the child brackets its own lifetime, so the
    // spec can count how many existed at once. Reported from *inside* the
    // process rather than sampled with `ps`, which is the stronger form of the
    // scenario's `Z`-state exclusion rather than a way around it: a process
    // that has written its `-` has exited, so a dead child cannot be counted
    // as live at all, and there is no polling window to miss a short one in.
    `  appendFileSync(${JSON.stringify(liveLog)}, '+' + Date.now() + '\\n');`,
    // Slowly, so a tick arrives while the turn is still running — which is the
    // precondition the scenario names, and the only way a re-entrant dispatch
    // could show itself.
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);',
    `  appendFileSync(${JSON.stringify(liveLog)}, '-' + Date.now() + '\\n');`,
    "  process.stderr.write('deflow-mock-agent: scripted to fail every turn\\n');",
    '  process.exit(1);',
    '}',
    '',
    // Everything else — the capability probe's ACP handshake above all — is
    // the bundled agent's, so this machine has a *working* provider that fails
    // its turns rather than a broken `PATH` entry.
    `const real = spawnSync(process.execPath, [${JSON.stringify(realAgent)}, ...argv], {`,
    "  stdio: 'inherit',",
    '});',
    'process.exit(real.status ?? 1);',
    '',
  ].join('\n');
}

/** Every binary the registry names for a provider that is not bundled. */
function vendorBinaries(): readonly string[] {
  const names = new Set<string>();
  for (const spec of Object.values(PROVIDER_SPECS)) {
    if (spec.bundled === true) continue;
    names.add(spec.bin);
    names.add(spec.shim.bin);
  }
  return [...names].toSorted();
}

function vendorCliOnPath(path: string): readonly string[] {
  const found: string[] = [];
  for (const dir of path.split(':')) {
    for (const bin of vendorBinaries()) {
      if (existsSync(join(dir, bin))) found.push(join(dir, bin));
    }
  }
  return found;
}

/** One run's event kinds, in `seq` order, or `null` before the stream exists. */
function kindsOf(dataDir: string, runId: string): readonly string[] | null {
  let db: ReturnType<typeof openRead> | null = null;
  try {
    db = openRead(join(dataDir, 'ledger.db'));
    const events = readRange(db, runId as RunId, 0, 500).events;
    return events.length === 0 ? null : events.map((event) => event.kind);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function waitFor<T>(what: string, read: () => T | null, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await sleep(100);
  }
  throw new Error(`${what} did not happen within ${String(timeoutMs)} ms`);
}

const RUN_ID = /run_\d{8}T\d{6}Z_[0-9a-f]{6}/;

/** True while the process exists at all — `kill(pid, 0)` and nothing more. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

suite('EPIC-19-S58 — a run that keeps failing gives up, says why, and exits', () => {
  it('bounds the retry, ends the run and returns the terminal', { timeout: 180_000 }, async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    writeFileSync(
      join(repo.dir, 'task.md'),
      '# Add a health endpoint\n\nExpose GET /health returning 200.\n',
      'utf8',
    );

    const liveLog = join(tmp, 'agent-lifetimes.log');
    writeFileSync(liveLog, '', 'utf8');
    const binDir = failingAgentOnly(liveLog);
    const path = [binDir, NODE_DIR, GIT_DIR].join(':');
    expect(vendorCliOnPath(path), 'a vendor agent CLI resolves on this PATH').toEqual([]);

    const cli = spawnCli({
      dataDir,
      cwd: repo.dir,
      argv: ['run', '--file', 'task.md'],
      binDirs: [binDir],
    });
    running.push(cli);

    const runId = await waitFor('the CLI printed a run id', () => {
      if (cli.child.exitCode !== null) {
        throw new Error(
          `deflow run exited ${String(cli.child.exitCode)} instead of admitting the run:\n` +
            `stderr:\n${cli.stderr()}\nstdout:\n${cli.stdout()}`,
        );
      }
      return RUN_ID.exec(cli.stdout())?.[0] ?? null;
    });

    // The command exits — of its own accord, because the run reached a terminal
    // state. Nothing here signals it. This is the clause the reported run
    // failed for seven minutes and a `kill`.
    const exit = await Promise.race([
      cli.exited,
      sleep(120_000).then(() => {
        throw new Error(
          `deflow run never exited; its transcript was:\n${cli.stdout()}\n${cli.stderr()}`,
        );
      }),
    ]);

    expect(exit.code, `stdout:\n${cli.stdout()}\nstderr:\n${cli.stderr()}`).toBe(1);
    expect(exit.signal).toBeNull();
    expect(alive(cli.child.pid ?? 0)).toBe(false);

    // A failure line per attempt, naming the node, the attempt out of the
    // ceiling and the typed reason — printed as they happened, not summarised.
    const transcript = cli.stdout();
    for (let attempt = 1; attempt <= DEFAULT_RETRY_POLICY.maxAttempts; attempt += 1) {
      expect(transcript, transcript).toContain(
        `attempt ${String(attempt)} of ${String(DEFAULT_RETRY_POLICY.maxAttempts)}`,
      );
    }
    expect(transcript).toContain('framing');

    // The ledger explains its own ending: one `node.failed` per attempt, then
    // `run.aborted`. No attempt was silent, and no fourth was made.
    const kinds = await waitFor('the run ended in the ledger', () => {
      const read = kindsOf(dataDir, runId);
      return read?.includes('run.aborted') === true ? read : null;
    });
    expect(kinds.filter((kind) => kind === 'node.failed')).toHaveLength(
      DEFAULT_RETRY_POLICY.maxAttempts,
    );
    expect(kinds.at(-1)).toBe('run.aborted');

    // EPIC-19-S61 scenario 2 / AC8 — one child at a time, counted from the
    // children rather than from the constant. Each turn holds its process open
    // for 1.5 s, which is many ticks, so a re-entrant dispatch would have
    // overlapped here rather than needing to be caught in a sampling window.
    const children = peakConcurrentChildren(liveLog);
    // Not vacuous: real children really did run, one per attempt.
    expect(children.started).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(children.peak, `peak concurrent agent children: ${String(children.peak)}`).toBe(1);

    // …and `deflow status` no longer reports it as active.
    //
    // *Dropped from the active-run summary* rather than *printed as `aborted`*,
    // because that is the authored contract for this surface: KAR-19.6 AC7
    // spells out that when a run stops, "`deflow status` drops it from its
    // active-run summary, `GET /api/runs?status=active` excludes it while plain
    // `GET /api/runs` still lists it with a terminal status". `status`'s Runs
    // section is the *active* runs by definition (`activeRuns` in
    // packages/cli/src/status.ts), and KAR-19.9 AC6 names the two surfaces that
    // must show the run as failed *with its reason* — `GET /api/runs/:id` and
    // the web run list — which `daemon/test/integration/failed-run-surfaces`
    // asserts. Asserting the word here would contradict AC7 and put a fourth
    // spelling of the ending in a third place.
    //
    // It still bites: before this story the framing turn retried every 30 s for
    // ever, so the run never reached a terminal status and sat in this summary
    // as "submitted — waiting to be framed" until the daemon was killed.
    const status = spawnCli({ dataDir, cwd: repo.dir, argv: ['status'], binDirs: [binDir] });
    running.push(status);
    await status.exited;
    expect(
      status.stdout(),
      `ledger now: ${(kindsOf(dataDir, runId) ?? []).join(', ')}\nrunId: ${runId}\nstderr: ${status.stderr()}`,
    ).not.toContain(runId);
  });
});
