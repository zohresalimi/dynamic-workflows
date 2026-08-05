/**
 * KAR-06.2 — two real agents never interleave their git index writes
 * (EPIC-06-S5 scenario 4, test-plan row 7, AC2).
 *
 * The sibling specs check that the lock is *computed* correctly:
 * `../../../core/src/decide.test.ts` over folded states, and
 * ./repo-lock-survives-restart.test.ts over a ledger a `SIGKILL`ed daemon left
 * behind. This one checks that it is *respected*, which the flow file says out
 * loud is a different claim:
 *
 * > The fourth scenario is the one that catches a lock that is computed
 * > correctly and then not actually respected at the effect boundary — a
 * > surprisingly common shape of bug, because the unit test passes.
 *
 * So nothing here is folded from a fixture. A real repository is initialised in
 * a tmpdir, a real ledger file records the run, and the command stream
 * `decide()` returns is performed by ./support/faithful-runner.ts — a loop that
 * spawns every `StartNode` it is given, immediately, with no exclusion of its
 * own. The two agents are real processes running real `git add` in one index.
 * If the scheduler ever admitted both, they would be in that index together,
 * and three independent observations would say so: the wall-clock intervals the
 * agents record, the porcelain each reads back while holding, and git itself
 * refusing a second concurrent `add` over `.git/index.lock`.
 *
 * Verifies: EPIC-06-S5 (scenario 4) · AC2
 */

import { git, it, makeRepo } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { appendEvents, drainEvents, openLedger } from '../../src/index.ts';
import { driveUntilQuiet, type Tick } from './support/faithful-runner.ts';
import { FIRST, SECOND, twoWritersReady, WRITER_RUN } from './support/git-writer-run.ts';

/** The instant the first tick is decided at; the loop moves it, not the machine. */
const START_AT = 1_754_402_400_000;

/**
 * How long each agent keeps the index after staging.
 *
 * Long enough that a second writer admitted on the same tick is unmistakably
 * inside the window — two processes spawned microseconds apart overlap by
 * essentially the whole of it — and short enough that the honest run, which
 * pays it twice in series, stays well inside the integration slice's timeout.
 */
const HOLD_MS = 250;

interface AgentEnter {
  readonly node: string;
  readonly phase: 'enter';
  readonly at: number;
}

interface AgentExit {
  readonly node: string;
  readonly phase: 'exit';
  readonly at: number;
  readonly add: { readonly exitCode: number; readonly stderr: string };
  readonly porcelainBefore: string;
  readonly porcelainAfter: string;
}

type AgentRecord = AgentEnter | AgentExit;

/** What the two agent processes observed, in the order they observed it. */
const readAgentLog = (path: string): AgentRecord[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as AgentRecord)
    : [];

/** One agent's whole visit: when it entered, and everything it saw. */
interface Visit {
  readonly node: string;
  readonly enteredAt: number;
  readonly exit: AgentExit;
}

function visits(records: readonly AgentRecord[]): Visit[] {
  const entries = records.filter((record): record is AgentEnter => record.phase === 'enter');
  return entries
    .map((entry) => {
      const exit = records.find(
        (record): record is AgentExit => record.phase === 'exit' && record.node === entry.node,
      );
      if (exit === undefined) throw new Error(`${entry.node} never finished`);
      return { node: entry.node, enteredAt: entry.at, exit };
    })
    .sort((left, right) => left.enteredAt - right.enteredAt);
}

/** `git status --porcelain` as `{ code, path }`, so the two spaces of `A  x` are not the assertion. */
const porcelain = (text: string): { code: string; path: string }[] =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));

interface Ledger {
  readonly kind: string;
  readonly seq: number;
  readonly node: string | null;
}

/** The run's events, flattened to what these assertions are about. */
function ledgerEvents(dataDir: string): Ledger[] {
  const db = openLedger(dataDir);
  try {
    return [...drainEvents(db, WRITER_RUN)].map((event) => ({
      kind: event.kind,
      seq: event.seq,
      node: (event.payload as { node?: string }).node ?? null,
    }));
  } finally {
    db.close();
  }
}

/** The commands of every tick, flattened. */
const allCommands = (ticks: readonly Tick[]): { kind: string; node?: string }[] =>
  ticks.flatMap((tick) => tick.commands as { kind: string; node?: string }[]);

interface Contended {
  readonly repo: string;
  readonly dataDir: string;
  readonly logPath: string;
  readonly ticks: readonly Tick[];
}

/**
 * The whole scenario, once: a real repository, a real ledger, and the two
 * writers driven to completion through the real command stream.
 */
async function contendForTheIndex(tmp: string): Promise<Contended> {
  const repo = join(tmp, 'proj');
  const dataDir = join(tmp, 'data');
  const logPath = join(tmp, 'agents.ndjson');

  await makeRepo({ dir: repo });
  await mkdir(dataDir, { recursive: true });

  const db = openLedger(dataDir);
  try {
    appendEvents(db, twoWritersReady(repo));
  } finally {
    db.close();
  }

  // A second connection over the same file, opened the way the daemon would.
  const engine = openLedger(dataDir);
  try {
    const { ticks } = await driveUntilQuiet({
      db: engine,
      runId: WRITER_RUN,
      repoDir: repo,
      logPath,
      holdMs: HOLD_MS,
      startAt: START_AT,
    });
    return { repo, dataDir, logPath, ticks };
  } finally {
    engine.close();
  }
}

suite('two real agents writing one git index (EPIC-06-S5 scenario 4)', () => {
  it('admits one writer at a time, so their index writes never overlap', async ({ tmp }) => {
    const run = await contendForTheIndex(tmp);
    const seen = visits(readAgentLog(run.logPath));

    // Both really ran. A lock that admitted nobody would satisfy every
    // non-interleaving assertion below vacuously.
    expect(seen.map((visit) => visit.node).sort()).toEqual([FIRST, SECOND].sort());

    // Neither hit `.git/index.lock`: git refuses a second concurrent `add`
    // rather than corrupting the index, so a zero exit from both is itself
    // evidence they were never in there together.
    expect(seen.map((visit) => visit.exit.add)).toEqual([
      { exitCode: 0, stderr: '' },
      { exitCode: 0, stderr: '' },
    ]);

    // The observation the scenario asks for: the second agent did not enter
    // until the first had left.
    const [first, second] = seen;
    if (first === undefined || second === undefined) throw new Error('two agents were expected');
    expect(
      second.enteredAt,
      `${second.node} entered the repository while ${first.node} still held it`,
    ).toBeGreaterThanOrEqual(first.exit.at);
  });

  it('shows each agent a stable "git status --porcelain" for the whole of its hold', async ({
    tmp,
  }) => {
    const run = await contendForTheIndex(tmp);
    const [first, second] = visits(readAgentLog(run.logPath));
    if (first === undefined || second === undefined) throw new Error('two agents were expected');

    // Nothing moved under either of them: the two reads, a whole hold apart,
    // are the same repository.
    expect(porcelain(first.exit.porcelainBefore)).toEqual(porcelain(first.exit.porcelainAfter));
    expect(porcelain(second.exit.porcelainBefore)).toEqual(porcelain(second.exit.porcelainAfter));

    // And the first agent never saw the second one's file at all — neither
    // staged (`A`) nor merely written (`??`), which is what a concurrent agent
    // one step behind would have looked like.
    expect(porcelain(first.exit.porcelainAfter)).toEqual([
      { code: 'A ', path: `${first.node}.txt` },
    ]);
    expect(porcelain(second.exit.porcelainAfter)).toEqual(
      [
        { code: 'A ', path: `${first.node}.txt` },
        { code: 'A ', path: `${second.node}.txt` },
      ].sort((left, right) => (left.path < right.path ? -1 : 1)),
    );

    // Both writes survived. Serialising them must not lose one.
    const staged = await git(run.repo, ['status', '--porcelain']);
    expect(
      porcelain(staged)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([`${FIRST}.txt`, `${SECOND}.txt`].sort());
  });

  it('records the two attempts as disjoint spans in the ledger', async ({ tmp }) => {
    const run = await contendForTheIndex(tmp);
    const events = ledgerEvents(run.dataDir);

    // "their node.started and node.completed seqs do not overlap": the
    // lifecycle events of the two nodes, in seq order, are AA then BB — never
    // ABAB, which is what two concurrently admitted writers would leave behind.
    const lifecycle = events
      .filter((event) => event.kind === 'node.started' || event.kind === 'node.completed')
      .map((event) => event.node);
    const [firstNode] = lifecycle;
    const otherNode = firstNode === FIRST ? SECOND : FIRST;
    expect(lifecycle).toEqual([firstNode, firstNode, otherNode, otherNode]);

    // Nobody failed: a failure would end the run early and make the ordering
    // above true for the wrong reason.
    expect(events.filter((event) => event.kind === 'node.failed')).toEqual([]);

    // The ledger never records two holders of the repo lock at once — the
    // invariant the whole story exists for, read back off the disk.
    const holders: string[] = [];
    for (const event of events) {
      if (event.kind === 'node.lock.acquired' && event.node !== null) holders.push(event.node);
      if (event.kind === 'node.lock.released') holders.length = 0;
      expect(holders.length, `two nodes held the repo lock at seq ${event.seq}`).toBeLessThan(2);
    }
  });

  it('withholds the second writer in decide(), not in the loop that performs commands', async ({
    tmp,
  }) => {
    const run = await contendForTheIndex(tmp);
    const commands = allCommands(run.ticks);

    // The first tick is where both nodes are ready and free of everything but
    // each other: exactly one acquisition and exactly one start come out of it.
    const opening = run.ticks[0]?.commands ?? [];
    expect(opening.filter((command) => command.kind === 'AcquireLock')).toHaveLength(1);
    expect(opening.filter((command) => command.kind === 'StartNode')).toHaveLength(1);

    // Over the whole run each node is started exactly once and takes the lock
    // exactly once. A retried or double-started node would mean the loop, not
    // the scheduler, was deciding when work happens.
    for (const node of [FIRST, SECOND]) {
      expect(
        commands.filter((command) => command.kind === 'StartNode' && command.node === node),
      ).toHaveLength(1);
      expect(
        commands.filter((command) => command.kind === 'AcquireLock' && command.node === node),
      ).toHaveLength(1);
    }
  });
});
