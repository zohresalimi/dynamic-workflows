/**
 * A real process that takes the single-instance lease at a wall-clock instant
 * agreed with its siblings, and reports what happened.
 *
 * Two daemons "started at the same time" is not two `acquireLease` calls a
 * hundred milliseconds apart — that ordering is what the sequential tests
 * already cover, and every acquisition scheme passes it. The case AC1 is about
 * is the one where the second process arrives *inside* the first one's
 * acquisition, so the barrier here is a busy-spin to a shared absolute instant
 * rather than an IPC message: message delivery jitter is milliseconds, and the
 * window this is hunting is microseconds.
 *
 * argv[2] is the data directory. The parent sends `{ at, offsetNs }`: `at` is
 * the shared instant in `Date.now()` milliseconds, `offsetNs` a further spin in
 * nanoseconds that staggers this process behind the others by a known amount,
 * so a sweep can walk the whole window instead of hoping to land in it.
 */
import { acquireLease, type Lease } from '../../../src/index.ts';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('usage: race-lease.ts <dataDir>');

/**
 * Every lease this process wins, kept strongly reachable.
 *
 * Deliberate: a racer that dropped the reference would be measuring the
 * garbage collector rather than the lock, and would report the lease as held
 * long after V8 had closed the connection out from under it.
 */
const won: Lease[] = [];

export interface RaceStart {
  readonly at: number;
  readonly offsetNs: string;
}

export interface RaceOutcome {
  readonly won: boolean;
  readonly pid: number;
  readonly errorName: string;
  readonly message: string;
  readonly holderPid: number | null;
}

process.on('message', (start: RaceStart) => {
  while (Date.now() < start.at) {
    // Spin to the shared instant. A timer would round to the millisecond and
    // hand back control at the event loop's convenience.
  }
  const until = process.hrtime.bigint() + BigInt(start.offsetNs);
  while (process.hrtime.bigint() < until) {
    // Spin this process's stagger.
  }

  let outcome: RaceOutcome;
  try {
    won.push(acquireLease(dataDir));
    outcome = { won: true, pid: process.pid, errorName: '', message: '', holderPid: null };
  } catch (error) {
    const thrown = error as Error & { pid?: number | null };
    outcome = {
      won: false,
      pid: process.pid,
      errorName: thrown.name,
      message: thrown.message,
      holderPid: thrown.pid ?? null,
    };
  }
  process.send?.(outcome);
});

process.send?.('ready');
