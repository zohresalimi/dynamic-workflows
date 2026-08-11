/**
 * KAR-16.5 AC4 — playback: the recorded run, committed over time.
 *
 * The player is the harness's *writer*. Where a live daemon's orchestrator
 * appends events as work happens, this appends the recorded ones as their
 * schedule makes them due — into the same ledger, through the same post-commit
 * signal, read back by the same serving loop. That is the whole trick behind
 * *"the UI cannot tell a replay from a live run"*: nothing downstream of the
 * write is different, so there is nothing downstream to branch on.
 *
 * Time enters through the injected `Clock` port and nowhere else — no
 * `Date.now()`, no bare `setTimeout` (docs/14-testing-strategy.md §8). A spec
 * drives a forty-minute recording in microseconds by advancing a `TestClock`,
 * while the socket's real I/O keeps arriving, which is exactly the trade fake
 * timers cannot make.
 *
 * ## Pause and seek, against an append-only log
 *
 * **Pause** holds the schedule: the origin is moved forward by however long the
 * pause lasted, so resuming continues the recording rather than firing every
 * event that came due while it was stopped.
 *
 * **Seek** is a fast-forward. `seek(4000)` commits everything up to and
 * including `seq` 4000 at once and resumes emission at the first recorded event
 * after it. A *backward* seek commits nothing and withdraws nothing — the
 * ledger is append-only and a row already served cannot be unserved — so it
 * moves the reported position only, and the client re-hydrates that position
 * from `GET /api/runs/:id/snapshot?seq=<N>`, which is the endpoint EPIC-15-S47
 * exists for. Pretending otherwise would mean a replay whose ledger can shrink,
 * and a fixture that no longer behaves like the production it stands in for.
 */
import type { Clock, Db } from '@DeFlow/core';
import { restoreRecordedEvents, type StoredEvent } from '@DeFlow/ledger';
import { Signal } from '../http/signal.ts';
import { log } from '../logging.ts';
import { emissionOffsets, type Speed } from './speed.ts';

const replay = log.child({ mod: 'replay' });

/**
 * How many events one transaction commits at most.
 *
 * The same bound, and for the same reason, as the stream's `DRAIN_BATCH`: at
 * `--speed max` a 400-node fixture is thousands of events with a zero-length
 * schedule, and committing them one transaction each turns the fast path into
 * the slow one (spike S5 measured 137k ev/s per-event against 1.08M batched).
 */
export const EMIT_BATCH = 500;

export interface PlayerOptions {
  readonly db: Db;
  readonly events: readonly StoredEvent[];
  readonly speed: Speed;
  readonly clock: Clock;
  /** Starts held at position 0 — what `DeFlow replay --paused` would want. */
  readonly startPaused?: boolean;
}

export interface Player {
  /** The greatest `seq` played so far; 0 before the first event. */
  position(): number;
  /** How many recorded events have been committed. */
  emitted(): number;
  paused(): boolean;
  pause(): void;
  resume(): void;
  /** Fast-forwards to `seq`; returns the position reached. */
  seek(seq: number): Promise<number>;
  /** Resolves when the whole recording has been committed, or playback stops. */
  played(): Promise<void>;
  /** Stops playback. The ledger is left exactly where it got to. */
  stop(): Promise<void>;
}

export function startPlayer(options: PlayerOptions): Player {
  const { db, events, speed, clock } = options;
  const offsets = emissionOffsets(events, speed);

  let index = 0;
  let position = 0;
  let paused = options.startPaused ?? false;
  let pausedAt = paused ? clock.now() : 0;
  let stopped = false;
  let origin = clock.now();

  const wake = new Signal();
  const abort = new AbortController();

  /** Commits `events[index … end)` in one transaction. */
  const commit = async (end: number): Promise<void> => {
    const slice = events.slice(index, end);
    if (slice.length === 0) return;
    await restoreRecordedEvents(db, slice);
    index = end;
    position = slice.at(-1)?.seq ?? position;
  };

  /** How many events are due at `now`, from `index`. */
  const dueBy = (now: number): number => {
    let end = index;
    while (end < events.length && origin + (offsets[end] ?? 0) <= now && end - index < EMIT_BATCH) {
      end += 1;
    }
    return end;
  };

  const loop = async (): Promise<void> => {
    while (!stopped && index < events.length) {
      if (paused) {
        await wake.wait();
        continue;
      }

      const now = clock.now();
      const end = dueBy(now);
      if (end > index) {
        await commit(end);
        continue;
      }

      const wait = origin + (offsets[index] ?? 0) - now;
      // Raced against the wake so a pause, a seek or a stop is noticed
      // immediately rather than after a recorded gap that may be hours long.
      await Promise.race([
        clock.sleep(Math.max(wait, 0), abort.signal).catch(() => undefined),
        wake.wait(),
      ]);
    }
  };

  const running = loop().catch((error: unknown) => {
    replay.error({ err: error }, 'replay playback failed');
    throw error;
  });

  return {
    position: () => position,
    emitted: () => index,
    paused: () => paused,

    pause: () => {
      if (paused || stopped) return;
      paused = true;
      pausedAt = clock.now();
      wake.notify();
    },

    resume: () => {
      if (!paused || stopped) return;
      paused = false;
      // The schedule is *held*, not skipped: a five-minute pause moves the
      // whole remaining timeline five minutes later, so resuming continues the
      // recording rather than firing everything that came due while stopped.
      origin += clock.now() - pausedAt;
      wake.notify();
    },

    seek: async (seq: number) => {
      let end = index;
      while (end < events.length && (events[end]?.seq ?? 0) <= seq) end += 1;
      await commit(end);
      // The reported position is where the operator asked to be, even when the
      // recording committed nothing (a backward seek, or a `seq` in a hole).
      position = seq;
      if (index < events.length) origin = clock.now() - (offsets[index] ?? 0);
      wake.notify();
      return position;
    },

    played: async () => {
      await running;
    },

    stop: async () => {
      stopped = true;
      abort.abort();
      wake.notify();
      await running.catch(() => undefined);
    },
  };
}
