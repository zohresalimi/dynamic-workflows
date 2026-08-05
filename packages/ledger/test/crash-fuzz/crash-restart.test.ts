/**
 * KAR-03.8 — the test that proves the thesis (EPIC-03-S26).
 *
 * "Everything else in the durability design is theory until this test is
 * green." A real scripted multi-node run, with real fake-agent binaries on a
 * real PATH, writing to a real file-backed ledger in `.DeFlow/`. At a seeded
 * random point the whole process **group** is `SIGKILL`ed — no handler, no
 * flush, no cleanup, and the agents die with their parent so the crash is an
 * instant rather than a window. Then the same scripted run is started again
 * over the same directory, and four things have to be true:
 *
 *   (a) the fake agents' own side-effect log holds no duplicate idempotency
 *       key, and the effect journal holds no ikey twice;
 *   (b) the reduced state equals the pre-crash projection at every seq the
 *       first life durably recorded one for;
 *   (c) `PRAGMA integrity_check` is `ok`;
 *   (d) the run completes, or halts with a typed failure — it never wedges.
 *
 * Two details are what make (a) and (b) mean anything.
 *
 * **(a) is checked against the fakes' own log**, not only against the journal.
 * The journal is the mechanism that is supposed to prevent a second execution;
 * asking it whether a second execution happened proves only that it agrees with
 * itself. Each fake binary appends `{runId, nodeId, attempt, idempotencyKey}`
 * on every invocation, so "executed twice" is a duplicate-key check on a text
 * file — an observation of the world.
 *
 * **(b) needs the pre-crash projection**, so the scripted run snapshots its
 * projected state after *every* event, from the first iteration. Retrofitting
 * that later is painful and the epic says so.
 *
 * `vi.useFakeTimers()` is forbidden anywhere in this file: child processes are
 * alive throughout, their real I/O would never arrive, and the spec would
 * deadlock for the whole timeout (docs/14-testing-strategy.md §8). Every wait
 * here polls a real clock.
 *
 * The seed comes from `$GITHUB_RUN_ID` when CI provides one, so a failure
 * reproduces from the log; `DeFlow_CRASH_SEED=<n>` re-runs a specific one, and
 * `DeFlow_KEEP_TMP=1` leaves the ledger on disk for the post-mortem.
 *
 * Verifies: EPIC-03-S26 · AC5, AC6
 */
import { canonicalJson, foldEvents, initialRunState, type RunId } from '@DeFlow/core';
import {
  crashSeed,
  duplicateIdempotencyKeys,
  it,
  mulberry32,
  readSideEffectLog,
  sleep,
  waitFor,
} from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { drainEvents, openAndReplay } from '../../src/index.ts';
import {
  FUZZ_RUN,
  type ScriptedRun,
  startScriptedRun,
  WEDGE_BUDGET_MS,
} from './support/scripted-run.ts';

const { seed, source } = crashSeed();
// Printed unconditionally: the number is only useful if it is in the log of the
// run that failed, and a seed you have to ask for is a seed you do not have.
process.stdout.write(`crash-fuzz seed ${seed} (from ${source})\n`);

/**
 * Repetitions of each kill window. One is enough to be a regression test; more
 * is what makes it a fuzzer, and CI is where that time is worth spending.
 */
const ITERATIONS = Number.parseInt(process.env.DeFlow_CRASH_FUZZ_ITERATIONS ?? '2', 10);

/**
 * The four windows EPIC-03-S26's Examples table names.
 *
 * `phase` is the marker the scripted run publishes as it goes; the harness
 * waits for it and then sleeps a seeded fraction of `spreadMs` before the kill,
 * so the knife lands somewhere *inside* the window rather than always on its
 * first instruction.
 */
const KILL_WINDOWS = [
  { name: 'a random point in the first node', phase: /^node:0:/, spreadMs: 120 },
  { name: 'a random point mid-run', phase: /^node:[34]:/, spreadMs: 120 },
  { name: 'a random point during a gate', phase: /^gate:/, spreadMs: 60 },
  { name: 'a random point during a retry backoff', phase: /^backoff:/, spreadMs: 120 },
  // The fifth window is not in the Examples table and is the most important
  // one: the effect has been performed and the journal has not recorded it
  // yet. It is the only instant at which a restart can execute something
  // twice, and it is far too narrow for a uniformly random kill point to find
  // — so it is aimed at rather than stumbled into.
  { name: 'the instant an effect is in doubt', phase: /^settling:/, spreadMs: 40 },
] as const;

interface Projection {
  readonly seq: number;
  readonly state: string;
}

/**
 * The projections the scripted run recorded, and the torn tail a SIGKILL is
 * allowed to leave.
 *
 * At most one line may be unreadable, and only the last: the file is appended
 * to synchronously after each committed event, so anything else torn is a bug
 * rather than a crash.
 */
function readProjections(path: string): { entries: Projection[]; torn: number } {
  if (!existsSync(path)) return { entries: [], torn: 0 };
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const entries: Projection[] = [];
  let torn = 0;
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as Projection);
    } catch {
      torn += 1;
    }
  }
  return { entries, torn };
}

/** Folds the surviving ledger, capturing the projection after every event. */
function foldCapturingEachSeq(dataDir: string): Map<number, string> {
  const opened = openAndReplay(dataDir, { enabled: false });
  try {
    const bySeq = new Map<number, string>();
    let state = initialRunState();
    for (const event of drainEvents(opened.db, FUZZ_RUN)) {
      state = foldEvents([event], state).state;
      bySeq.set(event.seq, canonicalJson(state));
    }
    return bySeq;
  } finally {
    opened.db.close();
  }
}

/** The last 20 events and the reduced state, for a failure that needs a story. */
function postMortem(dataDir: string): string {
  const opened = openAndReplay(dataDir);
  try {
    const events = [...drainEvents(opened.db, FUZZ_RUN)].slice(-20);
    return [
      `data directory: ${dataDir} (set DeFlow_KEEP_TMP=1 to keep it)`,
      `reduced state: ${canonicalJson(opened.runs.get(FUZZ_RUN) ?? null)}`,
      `last ${events.length} events:`,
      ...events.map((event) => `  ${event.seq} ${event.kind} ${canonicalJson(event.payload)}`),
    ].join('\n');
  } finally {
    opened.db.close();
  }
}

/**
 * Waits for the scripted run to publish a phase matching `pattern`, and fails
 * rather than hanging if the run finished without ever reaching it — a kill
 * window the run never enters would silently turn the iteration into "SIGKILL
 * a corpse", which asserts nothing.
 */
async function waitForPhase(run: ScriptedRun, pattern: RegExp, name: string): Promise<void> {
  await waitFor(
    () => {
      if (run.settled()) {
        throw new Error(`the scripted run finished without ever reaching ${name}`);
      }
      return pattern.test(run.phase());
    },
    { describe: `the scripted run to reach ${name}`, timeoutMs: WEDGE_BUDGET_MS },
  );
}

/**
 * One iteration, per kill window. A plain loop rather than `it.each`, because
 * Vitest works out which fixtures a test wants by reading the destructuring
 * pattern of its **first** parameter — and with `each` the first parameter is
 * the case, so `tmp` and `agentPath` would never be created.
 */
suite('crash-fuzz: kill, restart, assert four invariants (EPIC-03-S26)', () => {
  for (const killWindow of KILL_WINDOWS) {
    for (let iteration = 0; iteration < Math.max(ITERATIONS, 1); iteration += 1) {
      runIteration(killWindow, iteration);
    }
  }
});

function runIteration(killWindow: (typeof KILL_WINDOWS)[number], iteration: number): void {
  it(`survives SIGKILL at ${killWindow.name} (iteration ${iteration})`, async ({
    tmp,
    agentPath,
  }) => {
    // Seeded from the window and the iteration as well as the run seed, so two
    // cases in one run do not land on the same offset.
    const random = mulberry32(seed + killWindow.spreadMs + iteration * 7_919);
    const sideEffects = join(tmp, 'side-effects.ndjson');
    const projections = join(tmp, 'projections.ndjson');

    const first = startScriptedRun({
      dataDir: tmp,
      agent: agentPath.binary,
      sideEffects,
      projections,
      seed,
    });
    await waitForPhase(first, killWindow.phase, killWindow.name);
    await sleep(Math.floor(random() * killWindow.spreadMs));

    const crashed = await first.child.sigkill();
    expect(crashed.signal, 'the scripted run must be killed, not allowed to finish').toBe(
      'SIGKILL',
    );

    // What the dead process left behind. Read before the restart adds to it, so
    // the assertion below can prove the crash actually landed mid-run.
    const beforeRestart = readProjections(projections);
    expect(
      beforeRestart.entries.length,
      'the crash landed before the run did anything',
    ).toBeGreaterThan(0);
    expect(beforeRestart.torn, 'only the final line may be torn').toBeLessThanOrEqual(1);

    const second = startScriptedRun({
      dataDir: tmp,
      agent: agentPath.binary,
      sideEffects,
      projections,
      seed,
    });
    const exit = await second.child.exited;

    // (d) The run either completes or halts with a typed failure. A budget
    // exhausted here is a wedge, and a wedge is a failure — not a timeout.
    expect(exit, `the restarted run did not finish cleanly\n${second.child.stderr()}`).toEqual({
      code: 0,
      signal: null,
    });

    const after = readProjections(projections);
    expect(after.entries.length, 'the restart recorded no new projection').toBeGreaterThan(
      beforeRestart.entries.length,
    );

    // Everything the ledger has to say, read once and then closed: the
    // assertions below need a post-mortem string in their failure messages,
    // and building one while the write connection is still open would trip
    // `LedgerAlreadyOpen` on the way to reporting the real failure.
    const opened = openAndReplay(tmp);
    let observed: {
      status: string | undefined;
      outcome: string | undefined;
      integrity: unknown;
      done: string[];
    };
    try {
      const state = opened.runs.get(FUZZ_RUN as RunId);
      observed = {
        status: state?.status,
        outcome: state?.outcome ?? undefined,
        integrity: opened.db.pragma('integrity_check'),
        done: opened.db
          .prepare<{ ikey: string }>("SELECT ikey FROM effect WHERE state = 'done' ORDER BY ikey")
          .all()
          .map((row) => row.ikey),
      };
    } finally {
      opened.db.close();
    }

    const story = postMortem(tmp);

    // (d) The run either completes or halts with a typed failure — never wedges.
    expect(observed.status, story).toBe('completed');
    expect(observed.outcome, story).toBe('succeeded');

    // (c) integrity.
    expect(observed.integrity, story).toBe('ok');

    // (a) no effect executed twice — the fakes' own log first, because the
    // journal is the mechanism that is supposed to prevent it.
    const log = readSideEffectLog(sideEffects);
    expect(log.malformed, 'the side-effect log was torn').toBeLessThanOrEqual(1);
    expect(duplicateIdempotencyKeys(log.entries), story).toEqual([]);

    // (a) and the journal's own answer, which has to agree: every effect that
    // reached 'done' was performed exactly once, and really was performed.
    const performed = new Set(log.entries.map((entry) => entry.idempotencyKey));
    expect(new Set(observed.done).size).toBe(observed.done.length);
    for (const ikey of observed.done) expect(performed.has(ikey), `${ikey}\n${story}`).toBe(true);

    // (b) the reduced state equals the pre-crash projection at every seq the
    // first life durably recorded one for — and at every seq the second life
    // did, which is the same claim about the resumed fold.
    const bySeq = foldCapturingEachSeq(tmp);
    for (const projection of after.entries) {
      expect(bySeq.get(projection.seq), `projection at seq ${projection.seq}\n${story}`).toBe(
        projection.state,
      );
    }
    // Not vacuous: the crash really did happen partway through.
    expect(bySeq.size).toBeGreaterThan(beforeRestart.entries.length);
  });
}
