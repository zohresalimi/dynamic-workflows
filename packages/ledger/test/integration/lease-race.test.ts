/**
 * KAR-03.7 — the single-instance lease under a *concurrent* start.
 *
 * `lease.test.ts` and `e2e/two-daemons.test.ts` both establish the first lease
 * and wait for confirmation before the second process is allowed to try. That
 * is the ordering a user produces by typing in two terminals, and it is worth
 * testing — but it is not the ordering AC1 promises to survive. Anything that
 * launches DeFlowd programmatically — a supervisor, a container restart, a
 * script, this repo's own harnesses — starts two processes microseconds apart,
 * and an acquisition that is not atomic passes every sequential test while
 * failing that one.
 *
 * So these are sweeps: two real processes busy-spun to the same absolute
 * instant, one of them staggered by a known number of microseconds, walking
 * the whole width of the acquisition. The invariant is per round, not
 * statistical — exactly one holder, every loser told the same one sentence.
 *
 * Verifies: EPIC-03-S21 (scenario 1) · AC1, AC2
 */
import { it } from '@DeFlow/testkit';
import { type ChildProcess, fork } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { acquireLease, HOLDER_FILE, type Lease, LOCK_FILE } from '../../src/index.ts';
import type { RaceOutcome } from './support/race-lease.ts';

const RACER = fileURLToPath(new URL('./support/race-lease.ts', import.meta.url));
const DROPPER = fileURLToPath(new URL('./support/drop-lease.ts', import.meta.url));

const children: ChildProcess[] = [];
let mine: Lease | undefined;

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  mine?.release();
  mine = undefined;
});

/** Forks `script`, tracked for teardown. `execArgv` is cleared deliberately: the
 * child must not inherit the test runner's loader flags, only Node's own type
 * stripping. */
function child(script: string, args: string[], execArgv: string[] = []): ChildProcess {
  const forked = fork(script, args, { execArgv, stdio: 'pipe' });
  children.push(forked);
  return forked;
}

/** A racer, parked on the barrier, with its `ready` handshake already awaited. */
async function racer(dataDir: string): Promise<ChildProcess> {
  const forked = child(RACER, [dataDir]);
  await new Promise<void>((resolve, reject) => {
    forked.once('message', (message) => {
      if (message === 'ready') resolve();
      else reject(new Error(`the racer spoke before it was ready: ${JSON.stringify(message)}`));
    });
    forked.once('exit', (code) => reject(new Error(`the racer exited early with code ${code}`)));
  });
  return forked;
}

function outcomeOf(forked: ChildProcess): Promise<RaceOutcome> {
  return new Promise<RaceOutcome>((resolve, reject) => {
    forked.once('message', (message) => resolve(message as RaceOutcome));
    forked.once('exit', (code) => reject(new Error(`the racer exited before reporting: ${code}`)));
  });
}

/**
 * Starts `staggersUs.length` processes against one data directory, all released
 * at the same instant, each held back by its own stagger.
 */
async function startTogether(dataDir: string, staggersUs: number[]): Promise<RaceOutcome[]> {
  const racers = await Promise.all(staggersUs.map(() => racer(dataDir)));
  const outcomes = racers.map(outcomeOf);
  // 60 ms of lead: enough for the parent to hand every child its start message,
  // far too little for a fork to be the thing that decides the race.
  const at = Date.now() + 60;
  for (const [index, forked] of racers.entries()) {
    forked.send({ at, offsetNs: String((staggersUs[index] ?? 0) * 1000) });
  }
  return await Promise.all(outcomes);
}

/** The microsecond staggers a round of the sweep walks. */
function sweep(rounds: number, widthUs: number): number[] {
  return Array.from({ length: rounds }, (_, index) => Math.round((index / rounds) * widthUs));
}

/**
 * The timeout every sweep below is given, in place of the integration slice's
 * 30 s default.
 *
 * Nothing these sweeps assert is temporal: the invariants are per round and
 * structural — exactly one holder, one sentence, the right pid. But a sweep
 * *costs* two real Node process startups per round, 72 of them for a 36-round
 * sweep, run one after another, and process startup is precisely what an
 * oversubscribed box multiplies. Measured 2026-08-07: 7.1 s, 7.2 s and 9.2 s
 * isolated, against a 30 s default they then blew beside a full suite, where
 * eight forked workers are each spawning children of their own. That default
 * was therefore a flat wall-clock budget nobody wrote down, sitting about 4x
 * above the idle cost and measuring how busy the machine was — the same trap
 * EPIC-05's two timing budgets fell into, and the reason `project-slices` and
 * `worktree-reaping` both carry an explicit one.
 *
 * 120 s is ~13x the slowest sweep's idle cost: far enough out that reaching it
 * means a racer wedged on the lock and never reported, which is a real defect
 * and the only thing a timeout here should be able to say.
 */
const SWEEP_TIMEOUT_MS = 120_000;

suite('two daemons started at the same instant (AC1, AC2)', () => {
  it(
    'gives the lease to exactly one of them, every time',
    async ({ tmp }) => {
      // The window a two-phase acquisition leaves open is on the order of a
      // millisecond, so the sweep walks the first 900 µs in 25 µs steps and every
      // round is a fresh data directory: a stale winner would make the next round
      // trivially correct for the wrong reason.
      const rounds = 36;
      const results: RaceOutcome[][] = [];
      for (const staggerUs of sweep(rounds, 900)) {
        const dir = join(tmp, `round-${staggerUs}`);
        results.push(await startTogether(dir, [0, staggerUs]));
        for (const forked of children.splice(0)) forked.kill('SIGKILL');
      }

      const holders = results.map((round) => round.filter((outcome) => outcome.won).length);
      // Not "at most one": zero holders is the same story failing the other way —
      // both daemons refuse to start and the user has no daemon at all.
      expect(holders).toEqual(Array.from({ length: rounds }, () => 1));
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'tells the loser the same one sentence it tells a late arrival (AC2)',
    async ({ tmp }) => {
      const rounds = 36;
      const losers: RaceOutcome[] = [];
      for (const staggerUs of sweep(rounds, 900)) {
        const dir = join(tmp, `round-${staggerUs}`);
        const round = await startTogether(dir, [0, staggerUs]);
        losers.push(...round.filter((outcome) => !outcome.won));
        for (const forked of children.splice(0)) forked.kill('SIGKILL');
      }

      expect(losers).toHaveLength(rounds);
      // A raw SqliteError — `database is locked`, thrown by the commit inside a
      // two-phase acquisition when the loser's own pid read holds the file — is
      // the exact failure AC2 forbids, and it reaches the terminal as a stack.
      expect(losers.map((loser) => loser.errorName)).toEqual(
        Array.from({ length: rounds }, () => 'DaemonAlreadyRunning'),
      );
      for (const loser of losers) {
        expect(loser.message.split('\n')).toHaveLength(1);
        expect(loser.message).not.toMatch(
          /EWOULDBLOCK|SQLITE_BUSY|EAGAIN|errno|database is locked/i,
        );
      }
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'names the process that really holds it, to both the loser and a later daemon',
    async ({ tmp }) => {
      // Which of two processes released at the same instant reaches the lock
      // first is the scheduler's business, and deliberately not asserted here:
      // the head start is microseconds and the work in front of the lock —
      // mkdir, open, create the file — is hundreds of them. What *is* guaranteed
      // is that whoever is refused is told the truth about who won.
      const rounds = 24;
      for (const staggerUs of sweep(rounds, 900)) {
        const dir = join(tmp, `round-${staggerUs}`);
        const round = await startTogether(dir, [0, staggerUs]);
        const holder = round.find((outcome) => outcome.won);
        const loser = round.find((outcome) => !outcome.won);

        // `null` — "pid unknown" — is honest for the loser and allowed: the
        // winner may not have published its pid yet. Naming some *other* process
        // is not.
        expect([holder?.pid, null]).toContain(loser?.holderPid);

        // A third daemon, arriving once the dust has settled, gets no such
        // latitude: the winner is still running and still holds the lock, so it
        // must be named. An acquisition that hands the lock over mid-flight
        // leaves the pid of a process that lost the race — or died — behind for
        // this one to print, and the user goes and kills a stranger.
        const [late] = await startTogether(dir, [0]);
        expect(late?.won).toBe(false);
        expect(late?.holderPid).toBe(holder?.pid);

        for (const forked of children.splice(0)) forked.kill('SIGKILL');
      }
    },
    SWEEP_TIMEOUT_MS,
  );
});

suite('the lease is a lock, not a live object (AC1)', () => {
  it('survives its caller dropping every reference to it', async ({ tmp }) => {
    const dropper = child(DROPPER, [tmp], ['--expose-gc']);
    const held = await new Promise<{ pid: number }>((resolve, reject) => {
      dropper.once('message', (message) => resolve(message as { pid: number }));
      dropper.once('exit', (code) => reject(new Error(`the holder exited early: ${code}`)));
    });

    dropper.send('collect');
    await new Promise<void>((resolve, reject) => {
      dropper.on('message', (message) => {
        if (message === 'collected') resolve();
      });
      dropper.once('exit', (code) => reject(new Error(`the holder exited early: ${code}`)));
    });

    // The holder is still running and still believes it holds the lease.
    expect(dropper.exitCode).toBeNull();
    const [probe] = await startTogether(tmp, [0]);
    expect(probe?.won).toBe(false);
    expect(probe?.errorName).toBe('DaemonAlreadyRunning');
    expect(probe?.holderPid).toBe(held.pid);
  });

  it('writes nothing into the lock file, so there is no commit that could release it', async ({
    tmp,
  }) => {
    mine = acquireLease(tmp);

    // Zero bytes. The lock file's whole job is the fcntl lock the kernel takes
    // on it; a byte of content means a transaction was committed, and a commit
    // is precisely the moment the lock is let go.
    expect(statSync(join(tmp, LOCK_FILE)).size).toBe(0);
    // And no rollback journal — nothing for a SIGKILLed holder to leave behind.
    expect(readdirSync(tmp).sort()).toEqual([HOLDER_FILE, LOCK_FILE].sort());
  });
});
