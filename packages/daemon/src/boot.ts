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
 * Everything after the lease is fenced by `daemon_epoch` as well, which is the
 * belt to the lease's braces: `flock` semantics on network mounts are
 * unreliable, so the epoch is what makes a daemon that somehow started anyway
 * harmless (see @DeFlow/ledger's epoch.ts).
 */
import type { Db } from '@DeFlow/core';
import { acquireLease, bumpEpoch, type Lease, openLedger } from '@DeFlow/ledger';
import { resolveDataDir } from './data-dir.ts';
import { DEFAULT_HOSTNAME, DEFAULT_PORT, type StartedHttp, startHttp } from './http/server.ts';
import { log } from './logging.ts';
import { setDaemonEpoch } from './runtime.ts';

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
  /** Called as each step completes. The ordering assertion's only hook. */
  readonly onStep?: ((step: BootStep) => void) | undefined;
}

export interface Booted {
  readonly dataDir: string;
  readonly lease: Lease;
  readonly db: Db;
  /** This daemon life's epoch. Every event it appends carries it. */
  readonly epoch: number;
  readonly http: StartedHttp;
  /** Closes the port, the ledger and the lease, in that order. */
  shutdown(): Promise<void>;
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

  const dataDir = options.dataDir ?? resolveDataDir();
  step('resolve-data-dir');

  // Before anything else that touches the world.
  const lease = acquireLease(dataDir);
  step('lease');

  let db: Db;
  let epoch: number;
  try {
    db = openLedger(dataDir);
    epoch = bumpEpoch(db);
    setDaemonEpoch(epoch);
    step('migrate');

    // EPIC-05 fills this in. Its position is what KAR-03.7 asserts.
    step('probe-providers');
  } catch (error) {
    lease.release();
    throw error;
  }

  let http: StartedHttp;
  try {
    http = await startHttp({
      port: options.port ?? DEFAULT_PORT,
      hostname: options.hostname ?? DEFAULT_HOSTNAME,
      dev: options.dev,
    });
    step('bind-port');
  } catch (error) {
    db.close();
    lease.release();
    throw error;
  }

  daemon.info({ dataDir, epoch, pid: lease.pid }, 'DeFlowd booted');

  return {
    dataDir,
    lease,
    db,
    epoch,
    http,
    async shutdown(): Promise<void> {
      // Reverse order: stop accepting work, then close the ledger, then let
      // the next daemon in.
      await http.close();
      db.close();
      lease.release();
    },
  };
}
