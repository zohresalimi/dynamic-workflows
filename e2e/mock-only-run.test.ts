/**
 * KAR-19.7 AC9 / EPIC-19-S44 — a run submitted on a machine with **no vendor
 * agent CLI of any kind**, and only the bundled `deflow-mock-agent`.
 *
 * This is the acceptance case's admission half, and it is the half this story
 * actually delivered. Before the `mock` entry in `PROVIDER_SPECS` existed, this
 * machine was `e2e/admission.test.ts`'s machine: `admitRun` found nothing
 * usable, `deflow run` exited 5 with `no_usable_provider`, and `run.aborted` was
 * the last event of every run. What is asserted below is that it no longer is —
 * the bundled agent completes a real ACP handshake with the boot probe, the run
 * is admitted and submitted, and the framing turn it is waiting for is a durable
 * `node_wake` row rather than a refusal.
 *
 * **The clause that carries the scenario is the `PATH`**, so it is asserted
 * rather than arranged. `vendorCliOnPath` walks the `PATH` the CLI is actually
 * spawned with and looks for every binary `PROVIDER_SPECS` names — each vendor
 * CLI *and* each ACP bridge, read out of the registry rather than listed here,
 * so a provider added later is covered without anyone remembering to. A machine
 * where one of them resolves would make this spec pass for the wrong reason and
 * on that machine only, which is exactly what S44's Notes warn about.
 *
 * > **What is *not* asserted here, and why.** S44 also carries the ledger
 * > through `run.created`, `plan.proposed`, `node.started`, `node.completed` and
 * > a terminal `run.*`, with no credential variable in any child environment.
 * > None of that is reachable in this repository yet, and the reasons are
 * > cheaper to write down than to rediscover:
 * >
 * > - **`run.created` and `plan.proposed` are no longer among them.** KAR-19.3
 * >   bound the chain in `deflow up`, so this spec now carries the run through
 * >   its framing turn and asserts the F1.3 gate it parks on; the whole
 * >   sequence to `plan.proposed` is `e2e/live-chain.test.ts`, which approves
 * >   the gate. What is still unbound is `executeNodes`, which is KAR-19.4's
 * >   test plan #1 and #8.
 * > - **`node.completed` needs a return the bundled agent cannot serve.** The
 * >   default plan's agent nodes carry `returns.schemaId` `DeFlow.finding.v1`,
 * >   and `SCHEMA_GENERATORS` in `packages/mock-agent/src/structured.ts` serves
 * >   the four documents the *chain* needs and no node return, so a node run
 * >   against it would fail its handoff rather than complete.
 * > - **The credential clause is about a turn's child environment**, which
 * >   `buildChildEnv` builds and nothing yet calls on this path. The one child
 * >   this machine spawns today is the capability probe, which is handed the
 * >   daemon's own environment deliberately (`providers/boot-probe.ts`: *"the
 * >   probe hands the child the environment it was given"*), so asserting the
 * >   allowlist against it would be asserting it against the wrong process.
 * >
 * > The flows file and the epic's `Verified by` row both record S44 as partly
 * > automated for these reasons. The completion half closes with the
 * > composition-root binding, not here.
 *
 * Verifies: EPIC-19-S44 (the admission clauses) · KAR-19.7 AC9 · test plan #9,
 * in part
 */

import { PROVIDER_SPECS } from '@DeFlow/adapters';
import type { RunId } from '@DeFlow/core';
import { openLedger, readRange, readWakes } from '@DeFlow/ledger';
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
}

/** The daemon `deflow run` started for itself, stopped — it is detached, so
 * nothing else here will take it down. */
async function stopAutostartedDaemon(): Promise<void> {
  let file: DaemonFile;
  try {
    file = JSON.parse(readFileSync(join(tmp, 'data', 'daemon.json'), 'utf8')) as DaemonFile;
  } catch {
    return;
  }
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
 * Every binary the registry names for a provider that is **not** bundled — the
 * vendor CLI and the ACP bridge alike.
 *
 * Read out of `PROVIDER_SPECS` rather than written down, because the clause is
 * *"no vendor agent CLI of any kind"* and a hand-kept list stops being that the
 * first time a provider is added.
 */
function vendorBinaries(): readonly string[] {
  const names = new Set<string>();
  for (const spec of Object.values(PROVIDER_SPECS)) {
    if (spec.bundled === true) continue;
    names.add(spec.bin);
    names.add(spec.shim.bin);
  }
  return [...names].toSorted();
}

/** A bin directory holding `deflow-mock-agent` and nothing else. */
function bundledAgentOnly(): string {
  const dir = join(tmp, 'bin');
  mkdirSync(dir, { recursive: true });
  const link = join(dir, PROVIDER_SPECS.mock.bin);
  if (!existsSync(link)) symlinkSync(MOCK_AGENT_BIN, link);
  return dir;
}

/**
 * The vendor binaries that resolve on `path`, if any.
 *
 * The assertion is the empty array: a non-empty one means this machine has an
 * adapter the scenario is written to prove absent, and every claim below would
 * hold for that adapter's reason instead of this story's.
 */
function vendorCliOnPath(path: string): readonly string[] {
  const found: string[] = [];
  for (const dir of path.split(':')) {
    for (const bin of vendorBinaries()) {
      if (existsSync(join(dir, bin))) found.push(join(dir, bin));
    }
  }
  return found;
}

/** One `provider.probed` payload, as the boot probe writes it. */
interface Probed {
  readonly provider: string;
  readonly capsJson?: { readonly agentInfo?: { readonly name?: string } };
  /**
   * KAR-19.10 AC4 — present only on the row **admission** writes into the run's
   * own stream, naming the provider it chose and the route it will take. The
   * boot probe's rows never carry it, which is what lets the two be told apart
   * without knowing which synthetic run id the probe used.
   */
  readonly chosen?: { readonly route: string; readonly binaryPath: string };
}

interface Ledger {
  /** Every stream in the data directory, keyed by run id, in `seq` order. */
  readonly streams: ReadonlyMap<string, readonly string[]>;
  readonly probed: readonly Probed[];
}

/** Every event this data directory holds, grouped the way the ledger stores it.
 *
 * The boot probe writes `provider.probed` under a synthetic run of its own, so
 * the operator's run and the machine's capability record are two streams and
 * have to be read as two.
 */
function ledger(dataDir: string): Ledger {
  const db = openLedger(dataDir);
  try {
    const rows = db
      .prepare<{ run_id: string }>('SELECT run_id FROM event GROUP BY run_id ORDER BY MIN(seq)')
      .all();
    const streams = new Map<string, readonly string[]>();
    const probed: Probed[] = [];
    for (const row of rows) {
      const events = readRange(db, row.run_id as RunId, 0, 500).events;
      streams.set(
        row.run_id,
        events.map((event) => event.kind),
      );
      for (const event of events) {
        if (event.kind === 'provider.probed') probed.push(event.payload as unknown as Probed);
      }
    }
    return { streams, probed };
  } finally {
    db.close();
  }
}

/** Every wait this data directory holds — the audit view of `node_wake`. */
function wakes(dataDir: string): readonly { runId: string; nodeId: string; reason: string }[] {
  const db = openLedger(dataDir);
  try {
    return readWakes(db).map((wake) => ({
      runId: wake.runId,
      nodeId: wake.nodeId,
      reason: String(wake.reason),
    }));
  } finally {
    db.close();
  }
}

async function waitFor<T>(what: string, read: () => T | null, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await sleep(50);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`);
}

const RUN_ID = /run_\d{8}T\d{6}Z_[0-9a-f]{6}/;

suite('EPIC-19-S44 — a run framed on a machine with nothing installed', () => {
  it('admits deflow run --file on a PATH holding only deflow-mock-agent', async () => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    writeFileSync(
      join(repo.dir, 'spec.md'),
      '# Add a health endpoint\n\nExpose GET /health returning 200.\n',
      'utf8',
    );

    const binDir = bundledAgentOnly();
    const path = [binDir, NODE_DIR, GIT_DIR].join(':');

    // The clause the whole scenario rests on, asserted rather than arranged.
    expect(vendorCliOnPath(path), 'a vendor agent CLI resolves on this PATH').toEqual([]);
    expect(existsSync(join(binDir, PROVIDER_SPECS.mock.bin))).toBe(true);

    const cli = spawnCli({
      dataDir,
      cwd: repo.dir,
      argv: ['run', '--file', 'spec.md'],
      binDirs: [binDir],
    });
    running.push(cli);

    const runId = await waitFor('the CLI printed a run id', () => {
      if (cli.child.exitCode !== null) {
        throw new Error(
          `deflow run exited ${cli.child.exitCode} instead of admitting the run:\n` +
            `stderr:\n${cli.stderr()}\nstdout:\n${cli.stdout()}`,
        );
      }
      return RUN_ID.exec(cli.stdout())?.[0] ?? null;
    });

    const recorded = await waitFor('the submitted task reached the ledger', () => {
      const read = ledger(dataDir);
      return read.streams.get(runId)?.includes('task.submitted') === true ? read : null;
    });

    // Admission did not refuse. The refusal path writes every probe row and then
    // `run.aborted` into the run's own stream (`intake.ts`), so the submission
    // opening the stream and nothing ending it is the whole of S44's second
    // line. Asserted as "starts with, never aborted" rather than as an exact
    // list, because the clauses after it are the ones this story defers and a
    // spec that failed the day they started passing would be the wrong alarm.
    expect(recorded.streams.get(runId)?.[0]).toBe('task.submitted');
    for (const [stream, kinds] of recorded.streams) {
      expect(kinds, `${stream} was aborted`).not.toContain('run.aborted');
    }

    // …and it was admitted **because the bundled agent answered**, not because
    // some other adapter did. One probe row, for `mock`, and the handshake in it
    // is a real ACP `initialize` response from the binary on `PATH` — which is
    // what makes "no vendor CLI of any kind" a statement about this run rather
    // than about the directory listing above.
    // The probe rows: one, for `mock`, and the handshake in it is a real ACP
    // `initialize` response from the binary on `PATH`.
    const handshakes = recorded.probed.filter((row) => row.chosen === undefined);
    expect(handshakes.map((row) => row.provider)).toEqual([PROVIDER_SPECS.mock.id]);
    expect(handshakes[0]?.capsJson?.agentInfo?.name).toBe(PROVIDER_SPECS.mock.bin);

    // KAR-19.10 AC4 — and admission's own row, in the run's stream, saying what
    // it chose. On this machine there is only one thing it could have chosen,
    // which is the point: the choice is now *recorded* rather than implied.
    const chosen = recorded.probed.filter((row) => row.chosen !== undefined);
    expect(chosen.map((row) => row.provider)).toEqual([PROVIDER_SPECS.mock.id]);
    expect(chosen[0]?.chosen?.route).toBe('shim');

    // The wait is a durable row rather than a promise (KAR-19.1 AC1), and
    // KAR-19.3 changed *which* row it is: `deflow up` now binds the chain, so
    // the framing wake is consumed by the ticker within a second and what the
    // run is waiting on afterwards is the F1.3 gate. Asserting the framing row
    // itself would now be a race against the tick that does the work.
    //
    // So the clause is asserted where it survives: the run reaches
    // `run.created` — the framing turn ran against the bundled agent — and it
    // is then parked on a `human_gate` row for the operator's approval, with no
    // process held. `spec-approval` is the gate node's id and `human_gate` is
    // `WAKE_REASONS`' word for a blocking human node, both spelled out because
    // `@DeFlow/daemon` is deliberately not a dependency here (R2).
    await waitFor('the framing turn produced run.created', () =>
      ledger(dataDir).streams.get(runId)?.includes('run.created') === true ? true : null,
    );
    const parked = await waitFor('the run parked on the F1.3 gate', () => {
      const rows = wakes(dataDir).filter((wake) => wake.runId === runId);
      return rows.length > 0 ? rows : null;
    });
    expect(parked).toEqual([{ runId, nodeId: 'spec-approval', reason: 'human_gate' }]);

    // Nothing told the operator to install anything: the bundled binary is not
    // a package `npm install -g` can fetch (AC8).
    expect(cli.stderr()).not.toContain('npm install -g');

    // The attached view is still watching, which is what makes the exit a
    // detach rather than a refusal (KAR-18.3 AC3).
    expect(cli.child.exitCode).toBeNull();
    cli.child.kill('SIGINT');
    expect((await cli.exited).code).toBe(130);
  });
});
