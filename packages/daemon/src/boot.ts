/**
 * KAR-03.7 — DeFlowd's boot sequence, in the order the order matters
 * (docs/05-durable-execution.md §12, EPIC-03-S21).
 *
 *     resolve data dir → lease → migrate → probe providers → bind port
 *
 * The lease comes **second**, which is to say first among the steps that do
 * anything: before the ledger is opened for writing, before providers are
 * probed, before the port is bound. A second DeFlowd that gets as far as
 * spawning a capability probe has already changed the world before failing,
 * and one that gets as far as opening the ledger has already contended for the
 * write lock the lease exists to make unnecessary. `BOOT_STEPS` is exported
 * and asserted against so the order is a test rather than a convention.
 *
 * `reap-orphans` sits between the ledger and the first spawn for the same kind
 * of reason (KAR-05.9 AC7). Agents are started `detached: true` and therefore
 * survive the daemon that started them, so a crashed DeFlowd leaves real
 * processes editing a real worktree. They have to be dealt with before this
 * daemon starts anything of its own, or two generations of agents share a
 * worktree — and a capability probe is a spawn.
 *
 * Everything after the lease is fenced by `daemon_epoch` as well, which is the
 * belt to the lease's braces: `flock` semantics on network mounts are
 * unreliable, so the epoch is what makes a daemon that somehow started anyway
 * harmless (see @DeFlow/ledger's epoch.ts).
 */
import type { Clock, StallReport } from '@DeFlow/core';
import { type Db, describeSkipped, type RunId, type RunState } from '@DeFlow/core';
import {
  acquireLease,
  bumpEpoch,
  type Lease,
  type LedgerReplay,
  nextWakeAt as ledgerNextWakeAt,
  type Migration,
  openLedger,
  type RunReplay,
  replayAll,
} from '@DeFlow/ledger';
import { randomBytes } from 'node:crypto';
import { systemClock } from './clock.ts';
import {
  handoffUrl,
  ownProcessStartTime,
  removeDaemonFile,
  writeDaemonFile,
} from './daemon-file.ts';
import { resolveDataDir } from './data-dir.ts';
import { createRunDriver, type FramingRunner, type RunDriver } from './drive.ts';
import { mintDaemonToken } from './http/auth.ts';
import { clearIntakePorts, setIntakePorts } from './http/intake-ports.ts';
import {
  clearLedgerView,
  type OpenedLedgerView,
  openLedgerView,
  setLedgerView,
} from './http/ledger-view.ts';
import { installPtyUpgrade } from './http/pty-socket.ts';
import {
  clearUpgradeHandler,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  type StartedHttp,
  startHttp,
} from './http/server.ts';
import { log } from './logging.ts';
import type { ProviderDetectionEntry } from './providers/boot-probe.ts';
import { clearPtySessions } from './pty/pty-sessions.ts';
import { daemonRandom } from './random.ts';
import type { ReapDecision } from './reaper.ts';
import { type Recovery, type RecoveryStep, recover } from './recovery.ts';
import { setDaemonEpoch, setHeadSeq } from './runtime.ts';
import { stopChildren } from './shutdown.ts';
import { startTicker, TICK_INTERVAL_MS, type Ticker } from './ticker.ts';

/**
 * The 6-lowercase-hex suffix `mintRunId` (@DeFlow/core) needs — real entropy,
 * not the seeded backoff-jitter `Random` port: a `RunId` only has to be
 * unique, never reproducible the way a retry delay does for KAR-06.5's golden
 * sequences, and `node:crypto`'s CSPRNG is what `../mcp/host.ts` already uses
 * for the same kind of id-shaped token.
 */
function randomRunIdSuffix(): string {
  return randomBytes(3).toString('hex');
}

const daemon = log.child({ mod: 'boot' });

/**
 * The sequence, as data. Order is the acceptance criterion.
 *
 * `probe-providers` is a named slot rather than a step with a body: the
 * capability probe is EPIC-05's, and this file is where it will be called
 * from. It is here now — empty, and honest about being empty — because its
 * *position* is the thing under test, and a slot added later would be a slot
 * added after the ordering had stopped being checked.
 */
export const BOOT_STEPS = [
  'resolve-data-dir',
  'lease',
  'migrate',
  'reap-orphans',
  'probe-providers',
  'bind-port',
] as const;

export type BootStep = (typeof BOOT_STEPS)[number];

/**
 * The exit code of a second DeFlowd (AC2).
 *
 * 2 rather than a sysexits number, because it is the code
 * [EPIC-18](../../../docs/delivery/epics/EPIC-18-cli-packaging.md) specifies
 * for `DeFlow up` when the daemon is already running, and the CLI's contract
 * is what a user and a script actually see.
 */
export const EX_ALREADY_RUNNING = 2;

export interface BootOptions {
  /** Defaults to `resolveDataDir(process.env)`. */
  readonly dataDir?: string | undefined;
  readonly port?: number | undefined;
  readonly hostname?: string | undefined;
  /** Defaults to `process.env.DeFlow_DEV === '1'`, as `startHttp` does. */
  readonly dev?: boolean | undefined;
  /**
   * This life's bearer token. Defaults to a fresh one (KAR-15.2 AC7) — a
   * daemon never runs without one, and the only reason to pass one in is a
   * spec that wants to know the value before the daemon exists.
   */
  readonly token?: string | undefined;
  /** AC12 — the explicit flag, passed through to the bind. */
  readonly allowNonLoopback?: boolean | undefined;
  /** Called as each step completes. The ordering assertion's only hook. */
  readonly onStep?: ((step: BootStep) => void) | undefined;
  /**
   * KAR-18.2 — the `probe-providers` step's body.
   *
   * A port rather than a call into `./providers/boot-probe.ts`, because a probe
   * *spawns vendor binaries found on `PATH`*, and DeFlowd's own `PATH` at
   * daemon start is not the operator's login-shell one (§4.3). `DeFlow up`
   * runs in their terminal and knows the right environment; a daemon booted by
   * a spec, a fixture or a supervisor has no business searching whatever
   * `PATH` it inherited. Omitted means the step is a no-op and the report is
   * empty — which is honest, rather than a probe of the wrong machine.
   */
  readonly probeProviders?:
    | ((ports: { db: Db; dataDir: string }) => Promise<readonly ProviderDetectionEntry[]>)
    | undefined;
  /**
   * KAR-19.1 AC2 — the port `start-ticker` dispatches a due framing wake to.
   *
   * Omitted means the ticker still runs — the table is still read, and a stall
   * is still reported — and a due framing wake is logged rather than consumed.
   * That is the honest state of a daemon with no way to reach a provider, and
   * it is deliberately not a silent one.
   */
  readonly runFraming?: FramingRunner | undefined;
  /** AC7 — called for every `run.stalled` the driver appends, so `DeFlow up`
   * can print the one line the operator reads. */
  readonly onStalled?: ((runId: RunId, report: StallReport) => void) | undefined;
  /**
   * The clock the ticker and the run driver run on. Defaults to `systemClock`.
   *
   * Injected so a spec drives a ten-minute stall window in microseconds without
   * faking a timer (docs/14-testing-strategy.md §8). Recovery keeps the system
   * clock regardless: `daemonStartedAt` is a fact about *this process*, and an
   * inherited-effect boundary drawn on a test clock would be drawn in the
   * wrong place.
   */
  readonly clock?: Clock | undefined;
  /** Overridable so a spec can tick faster than 1 Hz; production never does. */
  readonly tickIntervalMs?: number | undefined;
  /** Called as each of `RECOVERY_STEPS`' eight completes — the assertion hook
   * for "boot performs all of them, `start-ticker` included". */
  readonly onRecoveryStep?: ((step: RecoveryStep) => void) | undefined;
  /**
   * The migration set, defaulting to every migration this build ships.
   *
   * The seam exists for one reason: shipped migrations are append-only and are
   * never edited once released (docs/05-durable-execution.md §7.2), so a spec
   * that needs to watch a migration *fail* — AC5's "the ledger is left at the
   * old user_version, and no HTTP listener was ever bound" — has no other way
   * to produce one.
   */
  readonly migrations?: readonly Migration[] | undefined;
}

export interface Booted {
  readonly dataDir: string;
  readonly lease: Lease;
  readonly db: Db;
  /** This daemon life's epoch. Every event it appends carries it. */
  readonly epoch: number;
  /** Every run in the data directory, rebuilt from the ledger (KAR-03.8). */
  readonly runs: ReadonlyMap<RunId, RunState>;
  /** The same runs, with how each one was rebuilt and what it could not read. */
  readonly replays: readonly RunReplay[];
  /** The highest `seq` the ledger held at replay. @see setHeadSeq */
  readonly headSeq: number;
  /** What the orphan reaper decided about each row the last daemon left
   * behind — reaped, discarded as a PID reuse, or already gone (KAR-05.9). */
  readonly reaped: readonly ReapDecision[];
  /**
   * What step 4 found: one entry per registered provider, `detected`,
   * `cached`, `not-installed` or `probe-failed`. Empty when no probe port was
   * supplied — which is not the same claim as "nothing is installed", and is
   * why `DeFlow up` is the caller that passes one.
   */
  readonly providers: readonly ProviderDetectionEntry[];
  readonly http: StartedHttp;
  /**
   * KAR-19.1 AC2 — `RECOVERY_STEPS`' eighth step, performed.
   *
   * Live by the time `boot()` returns, which is what makes the `node_wake` row
   * intake wrote a wait somebody is keeping rather than a row nothing reads.
   */
  readonly ticker: Ticker;
  /** The loop the ticker calls: wakes dispatched, stalls reported. */
  readonly driver: RunDriver;
  /** The port actually bound, and the one `.DeFlow/daemon.json` records. */
  readonly port: number;
  /** This life's bearer token (KAR-15.2 AC7). */
  readonly token: string;
  /**
   * The first-run handoff URL `DeFlow up` prints, token in the **fragment**.
   * Fragments are never sent to the server, so it cannot land in an access log.
   */
  readonly url: string;
  /** Closes the port, the ledger and the lease, in that order. */
  shutdown(): Promise<void>;
}

/**
 * What a replay has to say, at **one line per run** (EPIC-03-S16).
 *
 * The aggregate is the requirement, not a preference: a ledger written by a
 * newer DeFlowd can hold thousands of events this build has never heard of,
 * and an error line for each one during the replay of a nine-hour run is its
 * own denial of service. `describeSkipped` renders the sentence so its wording
 * is asserted by a unit test rather than by reading a terminal.
 *
 * A discarded checkpoint gets the same treatment: `warn`, one line, no stack
 * trace — nothing went wrong, and the daemon has already done the correct
 * thing by folding from zero.
 */
function reportReplay(replays: readonly RunReplay[]): void {
  for (const replay of replays) {
    const skipped = describeSkipped(replay.report);
    if (skipped !== null) daemon.info({ runId: replay.runId }, skipped);

    if (replay.discarded !== null) {
      daemon.warn(
        { runId: replay.runId, reason: replay.discarded.reason },
        replay.discarded.detail,
      );
    }

    if (replay.report.unreadable.length > 0) {
      daemon.warn(
        { runId: replay.runId, unreadable: replay.report.unreadable.length },
        `${replay.report.unreadable.length} events of run ${replay.runId} could not be read and ` +
          'were skipped; the projection is degraded rather than wrong',
      );
    }
  }
}

/**
 * Boots DeFlowd against `dataDir`.
 *
 * Throws `DaemonAlreadyRunning` — one sentence, no stack trace worth printing
 * — when another daemon holds the lease. Nothing has been opened, spawned or
 * bound when it does: that is the whole point of the ordering.
 */
export async function boot(options: BootOptions = {}): Promise<Booted> {
  const step = (name: BootStep): void => options.onStep?.(name);
  // KAR-19.1 AC2 — `RECOVERY_STEPS`' eight, reported as they are performed.
  // `recover()` does five of them and says so; the other three are this
  // function's, and until this story only two of those three happened.
  const recoveryStep = (name: RecoveryStep): void => options.onRecoveryStep?.(name);
  const clock = options.clock ?? systemClock;

  const dataDir = options.dataDir ?? resolveDataDir();
  step('resolve-data-dir');

  // A fresh token per daemon life, not per data directory: a token that
  // outlived the process that issued it would let a client drive the *next*
  // daemon with a credential it read from a file that daemon never wrote.
  const token = options.token ?? mintDaemonToken();

  // Before anything else that touches the world.
  const lease = acquireLease(dataDir);
  step('lease');
  recoveryStep('flock');

  let db: Db;
  let epoch: number;
  let replayed: LedgerReplay;
  let recovered: Recovery;
  let providers: readonly ProviderDetectionEntry[] = [];
  try {
    db = openLedger(dataDir, options.migrations);
    epoch = bumpEpoch(db);
    setDaemonEpoch(epoch);
    recoveryStep('bump-epoch');

    // F4.2: the run continues from the last completed boundary rather than
    // from zero. Before the port is bound, so nothing can ask about a run this
    // process has not rebuilt yet.
    //
    // Inside the `migrate` step rather than beside it as a sixth: §12's
    // sequence lists the moments this process changes something *outside*
    // itself — a lock file, a schema, a spawned probe, a bound port — and
    // folding a ledger it has already opened changes nothing at all. A step
    // nobody outside can observe does not belong in an ordering that is
    // asserted against.
    replayed = replayAll(db);
    setHeadSeq(replayed.headSeq);
    reportReplay(replayed.replays);
    step('migrate');

    // KAR-06.9 — the rest of §12's startup sequence: reconcile every effect a
    // dead daemon left `pending`, conclude the attempts that died holding
    // things, reap whatever is still running, and load the wakes that came due
    // while nothing was. `reap-orphans` is the one of the five that is also a
    // `BOOT_STEP`, because it is the one that changes something outside this
    // process — it signals other people's processes — and it must happen before
    // this daemon spawns anything of its own (KAR-05.9 AC7).
    //
    // The reconciliation runs with **no probes registered**, which means an
    // inherited `pending` row escalates to a human rather than being guessed
    // at. That is the same rule `durable()` applies to an effect that declares
    // no `reconcile`, and it is the conservative half of the two: the daemon
    // has no run driver yet, so nothing here journals effects, and the day one
    // does it must pass its probes in rather than inherit silence.
    recovered = await recover({
      db,
      clock: systemClock,
      epoch,
      daemonStartedAt: systemClock.now(),
      random: daemonRandom(),
      replayed,
      spillTo: dataDir,
      onStep: (name) => {
        if (name === 'reap-orphans') step('reap-orphans');
        recoveryStep(name);
      },
    });
    replayed = { ...replayed, runs: recovered.runs };

    // KAR-18.2 — step 4, after the reaper and before the bind. Its *position*
    // is what KAR-03.7 asserts and it has not moved: a probe is a spawn, and
    // spawning anything while a previous daemon's agents are still alive is
    // how two generations of agents end up in one worktree.
    //
    // A probe never fails a boot. `probeProvidersOnBoot` reports absence and
    // refusal as entries rather than throwing, and the one thing that could
    // still escape — a data directory that cannot be written — would have
    // failed the ledger open several lines above this.
    providers = (await options.probeProviders?.({ db, dataDir })) ?? [];
    step('probe-providers');
  } catch (error) {
    lease.release();
    throw error;
  }

  // KAR-19.1 AC2 — `RECOVERY_STEPS`' eighth and last step, which `recovery.ts`
  // has always declared and its only caller has never performed. Everything the
  // ordering protects is behind it: effects reconciled, dead attempts
  // concluded, orphans reaped, due wakes loaded. Only now may anything run.
  //
  // Before the bind rather than after, because the ticker needs no port and
  // §12's sequence puts the whole of recovery ahead of "this daemon accepts
  // work". A bind that then fails stops it again in the catch below.
  const driver = createRunDriver({
    db,
    clock,
    epoch,
    startedAt: clock.now(),
    spillTo: dataDir,
    ...(options.runFraming === undefined ? {} : { runFraming: options.runFraming }),
    ...(options.onStalled === undefined ? {} : { onStalled: options.onStalled }),
  });
  const tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
  const ticker = startTicker({
    clock,
    intervalMs: tickIntervalMs,
    onTick: (now) => driver.tick(now).then(() => undefined),
    nextWakeAt: () => ledgerNextWakeAt(db),
    // A tick that throws is a tick, not the end of the daemon: the loop is what
    // reconciles a run back to a sane state, so stopping on the first error is
    // how every run in the directory wedges at once.
    onError: (error) => daemon.error({ err: error }, 'a tick failed; the loop continues'),
  });
  recoveryStep('start-ticker');

  let http: StartedHttp;
  let view: OpenedLedgerView | null = null;
  try {
    // Registered *before* the port is bound, so no request can arrive at a
    // route whose ledger is not there yet — the same rule the SPA middleware
    // follows in startHttp, for the same reason.
    //
    // Its own read-only connection rather than `db`: better-sqlite3 is
    // synchronous, so serving a tail query off the writer would block every
    // append behind it (docs/11-api-and-realtime.md §5.1).
    view = openLedgerView(dataDir);
    setLedgerView(view);
    // KAR-10.1 — the write-side ports `POST /api/runs` and `DeFlow run` submit
    // a task through. Registered on the same write connection `boot` already
    // holds, not a second one: intake appends through the daemon's one writer,
    // the same as every other command.
    setIntakePorts({ db, epoch, clock: systemClock, dataDir, randomHex: randomRunIdSuffix });

    // KAR-15.8 — the one WebSocket route, registered before the port binds so
    // an upgrade can never arrive at a handler that is not there yet. It
    // answers 404 for a node with no live terminal, which is the honest answer
    // for a node that has finished: the panel falls back to the io endpoint.
    installPtyUpgrade();

    http = await startHttp({
      port: options.port ?? DEFAULT_PORT,
      hostname: options.hostname ?? DEFAULT_HOSTNAME,
      dev: options.dev,
      token,
      allowNonLoopback: options.allowNonLoopback,
    });

    // After the bind, because the port it records has to be the one that was
    // actually bound: `DeFlow status`, `DeFlow run` and the printed URL all
    // read this file, and a file naming the port the daemon *asked* for would
    // send all three somewhere nothing is listening.
    writeDaemonFile(dataDir, {
      pid: process.pid,
      port: http.port,
      token,
      startedAt: systemClock.now(),
      // KAR-18.7 AC4 — the evidence that makes the pid above checkable. Read
      // here rather than by whoever reads the file later, because by then this
      // pid may belong to something else entirely.
      processStartedAt: ownProcessStartTime(),
      // KAR-19.1 AC2 — the interval the ticker this daemon life started is
      // running at, so `DeFlow status` can report it. Written *after* the
      // ticker exists and removed with the file on shutdown, so it is a record
      // of something that happened rather than an intention.
      tickIntervalMs,
    });
    step('bind-port');
  } catch (error) {
    ticker.stop();
    clearUpgradeHandler();
    clearPtySessions();
    clearIntakePorts();
    clearLedgerView();
    view?.close();
    db.close();
    lease.release();
    throw error;
  }

  daemon.info(
    { dataDir, epoch, pid: lease.pid, runs: replayed.runs.size, headSeq: replayed.headSeq },
    'DeFlowd booted',
  );

  let stopped = false;

  return {
    dataDir,
    lease,
    db,
    epoch,
    runs: replayed.runs,
    replays: replayed.replays,
    headSeq: replayed.headSeq,
    reaped: recovered.reaped,
    providers,
    ticker,
    driver,
    http,
    port: http.port,
    token,
    url: handoffUrl(http.port, token),
    async shutdown(): Promise<void> {
      // Idempotent, like `lease.release()` and for the same reason: two
      // shutdowns is the normal shape of this, not a misuse. A signal handler
      // and a `finally` both reach for it, `node --watch` can deliver SIGTERM
      // twice, and a spec that stops a harness in `beforeAll` will stop it
      // again in `afterAll`. Everything below tolerated a second call by
      // accident until this one had a ledger *write* in it; now it says so.
      if (stopped) return;
      stopped = true;

      // Reverse order: stop accepting work, then close the ledger, then let
      // the next daemon in. The read view is unregistered before it is closed,
      // so a route can never reach a connection that has already gone.
      //
      // The daemon file goes first: for as long as it exists it advertises a
      // port and a token, and both stop being true the moment the port closes.
      // The ticker stops first: everything below closes something a tick reads,
      // and a tick that started before the ledger closed would be a tick
      // finishing against a connection that is gone.
      ticker.stop();
      removeDaemonFile(dataDir);
      await http.close();

      // KAR-18.2 AC7 — this daemon's own children, stopped and verified, and
      // the attempts that were holding them concluded so the next boot does
      // not have to reconcile a node no process is executing. After the port
      // closes, so nothing can start a further one while this runs, and before
      // the ledger closes, because concluding an attempt is a write.
      await stopChildren(db, {
        clock: systemClock,
        epoch,
        random: daemonRandom(),
        spillTo: dataDir,
      });
      // The sockets went with the server; the registry has to be emptied by
      // hand, or a second daemon in the same process would find this one's
      // dead terminals.
      clearUpgradeHandler();
      clearPtySessions();
      clearIntakePorts();
      clearLedgerView();
      view.close();
      db.close();
      lease.release();
    },
  };
}
