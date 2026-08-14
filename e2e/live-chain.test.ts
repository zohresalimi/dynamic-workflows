/**
 * KAR-19.3 AC1, AC2 / EPIC-19-S16 — the whole pre-execution chain, on the path
 * an operator actually takes.
 *
 * This is the story's test plan #1 at the level it was always written for. It
 * was automated at `integration` first and recorded as a departure, for a
 * reason that has since been spent: every schema-bearing turn is admitted only
 * onto an adapter that can take a schema, and until KAR-19.7 the bundled agent
 * could not — so no agent on a machine with no vendor CLI could serve a framing
 * turn, and an e2e against a real binary could not exist. It can now.
 *
 * What is under test here is **the composition root**, and nothing else in this
 * repository can test it. `packages/daemon/test/integration/live-chain.test.ts`
 * drives `createRunChain` end to end against scripted agent ports and is green;
 * it was green on 2026-08-12 too, while an operator's `DeFlow run` parked at the
 * framing wake and never moved, because `DeFlow up` bound no `runFraming` and no
 * `advanceRun` port. A spec that constructs the chain itself cannot see that.
 * So this one constructs nothing: it spawns the real `DeFlow` binary, which
 * starts a real daemon for itself, against a `PATH` holding one agent — the
 * bundled `DeFlow-mock-agent` — and reads the ledger those two processes left.
 *
 * **The `PATH` clause is asserted rather than arranged**, exactly as
 * `./mock-only-run.test.ts` asserts it: a machine where a vendor CLI resolves
 * would pass this spec for that adapter's reason instead of this story's.
 *
 * Verifies: EPIC-19-S16 · KAR-19.3 AC1, AC2, AC6 · test plan #1
 */

import { PROVIDER_SPECS } from '@DeFlow/adapters';
import type { RunId } from '@DeFlow/core';
import { openLedger, readRange } from '@DeFlow/ledger';
import { makeRepo } from '@DeFlow/testkit';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** The daemon `DeFlow run` started for itself, stopped — it is detached, so
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

/** A bin directory holding `DeFlow-mock-agent` and nothing else. */
function bundledAgentOnly(): string {
  const dir = join(tmp, 'bin');
  mkdirSync(dir, { recursive: true });
  const link = join(dir, PROVIDER_SPECS.mock.bin);
  if (!existsSync(link)) symlinkSync(MOCK_AGENT_BIN, link);
  return dir;
}

/** One run's event kinds, in `seq` order, or `null` before the stream exists. */
function kindsOf(dataDir: string, runId: string): readonly string[] | null {
  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(dataDir);
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
  let last: unknown = null;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    last = value;
    await sleep(100);
  }
  throw new Error(`${what} did not happen within ${String(timeoutMs)} ms (last: ${String(last)})`);
}

const RUN_ID = /run_\d{8}T\d{6}Z_[0-9a-f]{6}/;

/** The chain's own events, in the order EPIC-19-S16 names them. */
const CHAIN_KINDS = [
  'task.submitted',
  'run.created',
  'run.spec.approved',
  'spec.pinned',
  'plan.proposed',
] as const;

suite('EPIC-19-S16 — framing → the F1.3 gate → the pin → recon → a plan', () => {
  it('carries a real DeFlow run from a markdown file to plan.proposed', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    writeFileSync(
      join(repo.dir, 'task.md'),
      '# Add a health endpoint\n\nExpose GET /health returning 200.\n',
      'utf8',
    );

    const binDir = bundledAgentOnly();
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
          `DeFlow run exited ${String(cli.child.exitCode)} instead of admitting the run:\n` +
            `stderr:\n${cli.stderr()}\nstdout:\n${cli.stdout()}`,
        );
      }
      return RUN_ID.exec(cli.stdout())?.[0] ?? null;
    });

    // AC1 — the framing wake was consumed by the ticker, the interview ran
    // against the bundled agent, and `run.created` is in the log. Nothing in
    // this file made that happen: the daemon `DeFlow run` autostarted did.
    await waitFor('the framing turn produced run.created', () =>
      kindsOf(dataDir, runId)?.includes('run.created') === true ? true : null,
    );

    // The F1.3 gate, answered the way the UI answers it.
    const file = daemonFile();
    if (file === null) throw new Error('the autostarted daemon wrote no daemon.json');
    const approved = await fetch(
      `http://127.0.0.1:${String(file.port)}/api/runs/${runId}/spec/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${file.token}` },
        body: '{}',
      },
    );
    expect(approved.status).toBe(200);

    // AC2 — and from there the run continues with no further operator action:
    // the spec is pinned, recon runs, the planner compiles, `plan.proposed` is
    // appended. This is the assertion that was impossible before the binding.
    const kinds = await waitFor('the plan was compiled', () => {
      const read = kindsOf(dataDir, runId);
      return read?.includes('plan.proposed') === true ? read : null;
    });

    expect(
      kinds.filter((kind) => (CHAIN_KINDS as readonly string[]).includes(kind)),
      `the chain's own events, in seq order — the whole ledger was:\n${kinds.join('\n')}`,
    ).toEqual([...CHAIN_KINDS]);

    // Nothing was batched at the end: the gate's request is in the log before
    // the approval that answered it (AC2's "each step appends its own events").
    expect(kinds.indexOf('human.requested')).toBeLessThan(kinds.indexOf('run.spec.approved'));
  });
});
