/**
 * KAR-16.5 — `DeFlow replay <fixture> --speed <n>x --port <p>`: a daemon mode
 * that serves a recorded run (docs/03-local-development.md §6.2).
 *
 * > *"The UI cannot tell the difference, because there is no difference — the
 * > browser is a projection of an event stream either way."*
 *
 * The way that claim is kept is by refusing to write a replay server at all.
 * This function calls the **same `boot()`** `DeFlowd` calls: the same lease, the
 * same epoch bump, the same ledger view, the same `startHttp`, the same auth,
 * the same `/api/*` chain and the same SSE loop. The only difference is who
 * writes the events — a recording on a schedule (`./player.ts`) instead of an
 * orchestrator — and that difference lives entirely on the write side, where no
 * client can observe it. There is consequently nothing for the web codebase to
 * branch on, which is AC2 stated as a property of the design rather than as a
 * lint rule.
 *
 * Two consequences worth stating, because both are acceptance criteria:
 *
 * - **Auth is not bypassed** (AC5). `boot()` mints a token and `startHttp`
 *   enforces it, so an unauthenticated `/api/runs` is 401 here exactly as it is
 *   in production and `GET /api/health` stays the only open route. A harness
 *   that skipped auth would be a harness that lets an auth regression ship,
 *   because the harness is what most development runs against.
 * - **The data directory is the harness's own.** A recording is restored with
 *   its recorded `seq`, which may only ever be done into a ledger whose head is
 *   below it (`restoreRecordedEvents`), so a replay can never be pointed at a
 *   real `.DeFlow/` and graft a fixture onto somebody's run.
 */
import type { Clock, RunId } from '@DeFlow/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { type Booted, boot } from '../boot.ts';
import { systemClock } from '../clock.ts';
import { log } from '../logging.ts';
import { loadFixture, type RecordedLedger } from './fixture.ts';
import { type Player, startPlayer } from './player.ts';
import { parseSpeed, type Speed } from './speed.ts';

const replay = log.child({ mod: 'replay' });

export interface ReplayOptions {
  /** Path to the recording — one `events.jsonl` under `test/fixtures/runs/`. */
  readonly fixture: string;
  /** Defaults to `1x`, the speed the run was recorded at. */
  readonly speed?: Speed;
  /** `0` binds an ephemeral port, which is what every spec uses. */
  readonly port?: number;
  readonly hostname?: string;
  /** Defaults to a fresh directory under the OS tmpdir. Never a real `.DeFlow/`. */
  readonly dataDir?: string;
  /** Defaults to a freshly minted one, as `boot()` does. */
  readonly token?: string;
  /** Serves the UI through Vite in middleware mode, as `pnpm dev` does. */
  readonly dev?: boolean;
  /** The SSE idle cadence, for a spec that cannot wait 15 s to see one. */
  readonly keepaliveMs?: number;
  /** Injected for tests; the default is the system clock. */
  readonly clock?: Clock;
  /** Boots with playback held at position 0. */
  readonly startPaused?: boolean;
}

export interface ReplayHarness {
  readonly origin: string;
  readonly port: number;
  readonly token: string;
  readonly dataDir: string;
  /** The first-run handoff URL, token in the fragment, as `DeFlow up` prints. */
  readonly url: string;
  /** Every run the recording holds, in first-seen order. */
  readonly runIds: readonly RunId[];
  /** The highest recorded `seq` — where a fully played fixture ends up. */
  readonly headSeq: number;
  /** How many events the recording holds. */
  readonly recorded: number;
  /** Every recorded `seq`, in order — what a seek names. */
  readonly seqs: readonly number[];
  /** The greatest `seq` played so far. */
  position(): number;
  /** How many recorded events have been committed. */
  emitted(): number;
  paused(): boolean;
  pause(): void;
  resume(): void;
  seek(seq: number): Promise<number>;
  /** Resolves once the whole recording has been served. */
  played(): Promise<void>;
  /**
   * Destroys every open socket: no final frame, no clean end, and no `close`
   * the client could mistake for the server being finished.
   *
   * Playback is untouched — the recording keeps advancing while nobody is
   * listening, which is the half that makes a reconnect prove anything. This is
   * the harness's part of Playwright smoke #4
   * ([14 §13](../../../../docs/14-testing-strategy.md)), *"replay at speed,
   * **kill the connection**, assert the UI reconnects and backfills without a
   * gap or a duplicate"* — the smoke is specified as running against this
   * harness, so the severance belongs to it rather than to a proxy a spec
   * stands up in front of it. A browser cannot sever a stream it has already
   * opened: `setOffline` blocks new requests and leaves an established SSE
   * socket streaming, so the only honest place to cut is here.
   */
  sever(): void;
  close(): Promise<void>;
}

/** Boots a daemon over a recording and starts playing it. */
export async function startReplay(options: ReplayOptions): Promise<ReplayHarness> {
  const fixture: RecordedLedger = await loadFixture(options.fixture);
  const speed = options.speed ?? parseSpeed('1x');
  const clock = options.clock ?? systemClock;

  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'DeFlow-replay-')));

  // The idle cadence is read per connection out of the environment, the same
  // knob EPIC-15's own specs turn. Set on this process because a replay *is* a
  // daemon process; restored on close so a spec that boots two harnesses in one
  // worker does not inherit the first one's cadence.
  const keepaliveWas = process.env.DeFlow_SSE_KEEPALIVE_MS;
  if (options.keepaliveMs !== undefined) {
    process.env.DeFlow_SSE_KEEPALIVE_MS = String(options.keepaliveMs);
  }

  let booted: Booted;
  try {
    booted = await boot({
      dataDir,
      port: options.port ?? 7777,
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      ...(options.token === undefined ? {} : { token: options.token }),
      dev: options.dev ?? false,
    });
  } catch (error) {
    restoreKeepalive(keepaliveWas);
    throw error;
  }

  let player: Player;
  try {
    player = startPlayer({
      db: booted.db,
      events: fixture.events,
      speed,
      clock,
      ...(options.startPaused === undefined ? {} : { startPaused: options.startPaused }),
    });
  } catch (error) {
    await booted.shutdown();
    restoreKeepalive(keepaliveWas);
    throw error;
  }

  replay.info(
    {
      fixture: fixture.path,
      events: fixture.events.length,
      runs: fixture.runIds.length,
      headSeq: fixture.headSeq,
      spanMs: fixture.spanMs,
      speed: speed.kind === 'max' ? 'max' : `${speed.factor}x`,
      port: booted.port,
    },
    'replaying a recorded run',
  );

  return {
    origin: `http://${options.hostname ?? '127.0.0.1'}:${booted.port}`,
    port: booted.port,
    token: booted.token,
    dataDir,
    url: booted.url,
    runIds: fixture.runIds,
    headSeq: fixture.headSeq,
    recorded: fixture.events.length,
    seqs: fixture.events.map((event) => event.seq),
    position: () => player.position(),
    emitted: () => player.emitted(),
    paused: () => player.paused(),
    pause: () => player.pause(),
    resume: () => player.resume(),
    seek: (seq) => player.seek(seq),
    played: () => player.played(),
    sever: () => {
      booted.http.server.closeAllConnections();
    },
    close: async () => {
      // Playback first: a player still committing into a ledger the shutdown
      // has closed is a confusing SQLite error rather than an honest stop.
      await player.stop();
      await booted.shutdown();
      restoreKeepalive(keepaliveWas);
    },
  };
}

function restoreKeepalive(was: string | undefined): void {
  if (was === undefined) delete process.env.DeFlow_SSE_KEEPALIVE_MS;
  else process.env.DeFlow_SSE_KEEPALIVE_MS = was;
}
