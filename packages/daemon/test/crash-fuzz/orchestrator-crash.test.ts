/**
 * KAR-06.9 — the test the epic is for (EPIC-06-S29).
 *
 * *"Everything else in the durability design is theory until this test is
 * green."* A real scripted multi-node run driven by the real `decide()`, the
 * real effect journal and real fake-agent binaries, against a real
 * file-backed ledger. At a seeded random point inside a chosen window the whole
 * process **group** is `SIGKILL`ed — no handler, no flush, no cleanup, and the
 * agents die with their parent so the crash is an instant rather than a window.
 * Then a second daemon life starts over the same directory, runs `recover()`
 * and finishes the run, and four things have to be true:
 *
 *   (a) the fake agents' own side-effect log holds no duplicate idempotency
 *       key, and no ikey reached `done` without having been performed;
 *   (b) the post-restart fold equals the pre-crash projection at every seq the
 *       first life durably recorded one for — resuming from "strictly greater
 *       than my cursor", because `AUTOINCREMENT` leaves gaps;
 *   (c) `PRAGMA integrity_check` returns `ok`;
 *   (d) the run completes, or halts with a typed `NodeFailure` — it never
 *       wedges. A budget exhausted here is a wedge, and a wedge is a failure,
 *       not a timeout.
 *
 * **SIGKILL, never SIGTERM.** SIGTERM tests the shutdown handler; SIGKILL tests
 * durability, and durability is the only thing this suite is about.
 *
 * `vi.useFakeTimers()` is forbidden anywhere in this file: child processes are
 * alive throughout, their real I/O would never arrive, and the spec would
 * deadlock for the whole timeout (docs/14-testing-strategy.md §8).
 *
 * The seed comes from `$GITHUB_RUN_ID` when CI provides one, so a failure
 * reproduces from the log; `DeFlow_CRASH_SEED=<n>` re-runs a specific one, and
 * `DeFlow_KEEP_TMP=1` leaves the ledger on disk for the post-mortem.
 *
 * Verifies: EPIC-06-S29, EPIC-06-S11, EPIC-06-S16, EPIC-06-S30 · AC6–AC9
 */
import { canonicalJson, foldEvents, initialRunState } from '@DeFlow/core';
import { drainEvents, openAndReplay } from '@DeFlow/ledger';
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
import { RECOVERY_RUN } from '../integration/support/recovery-run.ts';
import { type DaemonLife, startDaemonLife, WEDGE_BUDGET_MS } from './support/daemon-life.ts';

const { seed, source } = crashSeed();
// Printed unconditionally: the number is only useful if it is in the log of the
// run that failed, and a seed you have to ask for is a seed you do not have.
process.stdout.write(`orchestrator crash-fuzz seed ${seed} (from ${source})\n`);

/** Repetitions per window. One is a regression test; more is a fuzzer. */
const ITERATIONS = Number.parseInt(process.env.DeFlow_CRASH_FUZZ_ITERATIONS ?? '1', 10);

/**
 * Where the knife may land.
 *
 * `phase` is the marker the daemon life publishes as it goes; the harness waits
 * for it and then sleeps a seeded fraction of `spreadMs`, so the kill lands
 * somewhere *inside* the window rather than always on its first instruction.
 */
const KILL_WINDOWS = [
  { name: 'the middle of an attempt', phase: /^node:/, spreadMs: 90 },
  // The most important window, and far too narrow for a uniformly random kill
  // point to find: the effect has been performed and the journal does not know
  // yet. It is the only instant at which a restart can execute something twice,
  // so it is aimed at rather than stumbled into.
  { name: 'the instant an effect is in doubt', phase: /^settling:/, spreadMs: 35 },
  { name: 'recovery itself', phase: /^recovering/, spreadMs: 12 },
] as const;

interface Projection {
  readonly seq: number;
  readonly state: string;
}

/**
 * The projections a life recorded, and the torn tail a SIGKILL is allowed to
 * leave: at most one line, and only the last.
 */
function readProjections(path: string): { entries: Projection[]; torn: number } {
  if (!existsSync(path)) return { entries: [], torn: 0 };
  const entries: Projection[] = [];
  let torn = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      torn += 1;
      continue;
    }
    const record = parsed as Partial<Projection>;
    // The recovery summary line carries no seq; it is a note, not a projection.
    if (typeof record.seq === 'number' && typeof record.state === 'string') {
      entries.push({ seq: record.seq, state: record.state });
    }
  }
  return { entries, torn };
}

/**
 * Folds the surviving ledger, capturing the projection after every event.
 *
 * The walk is over `drainEvents`, which resumes from "strictly greater than my
 * cursor" — the only correct way to read a table whose `seq` has gaps.
 */
function foldCapturingEachSeq(dataDir: string): Map<number, string> {
  const opened = openAndReplay(dataDir, { enabled: false });
  try {
    const bySeq = new Map<number, string>();
    let state = initialRunState();
    for (const event of drainEvents(opened.db, RECOVERY_RUN)) {
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
    const events = [...drainEvents(opened.db, RECOVERY_RUN)].slice(-20);
    return [
      `data directory: ${dataDir} (set DeFlow_KEEP_TMP=1 to keep it)`,
      `reduced state: ${canonicalJson(opened.runs.get(RECOVERY_RUN) ?? null)}`,
      `last ${events.length} events:`,
      ...events.map((event) => `  ${event.seq} ${event.kind} ${canonicalJson(event.payload)}`),
    ].join('\n');
  } finally {
    opened.db.close();
  }
}

/**
 * Waits for the life to publish a phase matching `pattern`, and fails rather
 * than hanging if it finished without ever reaching it — a window the run never
 * enters would silently turn the iteration into "SIGKILL a corpse".
 */
async function waitForPhase(life: DaemonLife, pattern: RegExp, name: string): Promise<void> {
  await waitFor(
    () => {
      if (life.settled()) throw new Error(`the daemon life finished without reaching ${name}`);
      return pattern.test(life.phase());
    },
    { describe: `the daemon life to reach ${name}`, timeoutMs: WEDGE_BUDGET_MS },
  );
}

suite('crash-fuzz: SIGKILL at a random point, restart, four invariants (EPIC-06-S29)', () => {
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
    const random = mulberry32(seed + killWindow.spreadMs + iteration * 7_919);
    const sideEffects = join(tmp, 'side-effects.ndjson');
    const projections = join(tmp, 'projections.ndjson');
    const life = (): DaemonLife =>
      startDaemonLife({
        dataDir: tmp,
        agent: agentPath.binary,
        sideEffects,
        projections,
        seed,
      });

    const first = life();
    await waitForPhase(first, killWindow.phase, killWindow.name);
    await sleep(Math.floor(random() * killWindow.spreadMs));

    const crashed = await first.child.sigkill();
    expect(crashed.signal, 'the daemon life must be killed, not allowed to finish').toBe('SIGKILL');

    const beforeRestart = readProjections(projections);
    expect(beforeRestart.torn, 'only the final line may be torn').toBeLessThanOrEqual(1);

    const second = life();
    const exit = await second.child.exited;

    // (d) The restart finishes. A budget exhausted inside it throws, which is
    // how a wedge becomes a failure rather than a timeout.
    expect(exit, `the restarted life did not finish cleanly\n${second.child.stderr()}`).toEqual({
      code: 0,
      signal: null,
    });

    // Everything the ledger has to say, read once and then closed: the
    // assertions below want a post-mortem in their failure messages, and
    // building one while the write connection is open would trip
    // `LedgerAlreadyOpen` on the way to reporting the real failure.
    const opened = openAndReplay(tmp);
    let observed: {
      status: string | undefined;
      failures: unknown[];
      integrity: unknown;
      done: string[];
      pending: string[];
    };
    try {
      const state = opened.runs.get(RECOVERY_RUN);
      observed = {
        status: state?.status,
        failures: Object.values(state?.nodes ?? {})
          .map((node) => node.failure)
          .filter((failure) => failure !== null),
        integrity: opened.db.pragma('integrity_check'),
        done: opened.db
          .prepare<{ ikey: string }>("SELECT ikey FROM effect WHERE state = 'done' ORDER BY ikey")
          .all()
          .map((row) => row.ikey),
        pending: opened.db
          .prepare<{
            ikey: string;
          }>("SELECT ikey FROM effect WHERE state = 'pending' ORDER BY ikey")
          .all()
          .map((row) => row.ikey),
      };
    } finally {
      opened.db.close();
    }

    const story = postMortem(tmp);

    // (d) The run either completes or halts — it never wedges. When it halted,
    // it halted on a *typed* failure rather than on silence.
    expect(['completed', 'aborted'], story).toContain(observed.status);
    if (observed.status === 'aborted') {
      expect(observed.failures.length, story).toBeGreaterThan(0);
      for (const failure of observed.failures) {
        expect(failure, story).toMatchObject({
          reason: expect.any(String),
          class: expect.any(String),
        });
      }
    }
    // And nothing was left claimed-but-unresolved: every inherited row was
    // reconciled, which is what makes "reconciled exactly once at startup" a
    // claim about the whole journal rather than about one row.
    expect(observed.pending, story).toEqual([]);

    // (c) integrity.
    expect(observed.integrity, story).toBe('ok');

    // (a) no effect executed twice — the fakes' own log first, because the
    // journal is the mechanism that is supposed to prevent it.
    const log = readSideEffectLog(sideEffects);
    expect(log.malformed, 'the side-effect log was torn').toBeLessThanOrEqual(1);
    expect(duplicateIdempotencyKeys(log.entries), story).toEqual([]);

    // (a) and the journal's own answer, which has to agree: every effect that
    // reached `done` really was performed, exactly once.
    const performed = new Set(log.entries.map((entry) => entry.idempotencyKey));
    expect(new Set(observed.done).size).toBe(observed.done.length);
    for (const ikey of observed.done) expect(performed.has(ikey), `${ikey}\n${story}`).toBe(true);

    // (b) the fold equals every projection either life recorded, at the seq it
    // recorded it for.
    const after = readProjections(projections);
    const bySeq = foldCapturingEachSeq(tmp);
    for (const projection of after.entries) {
      expect(bySeq.get(projection.seq), `projection at seq ${projection.seq}\n${story}`).toBe(
        projection.state,
      );
    }
    // Not vacuous: the crash really did land partway through a live run.
    expect(after.entries.length, story).toBeGreaterThan(beforeRestart.entries.length);
  });
}
