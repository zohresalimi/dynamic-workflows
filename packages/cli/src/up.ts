/**
 * `DeFlow up` (KAR-18.2) — the eight numbered steps of
 * [docs/03-local-development.md §9](../../../docs/03-local-development.md) as
 * one sequenced boot, and the operator-facing behaviour of each refusal.
 *
 * The command is thin on purpose. Every step it owns already exists somewhere
 * with its own tests — the lease and the epoch are `@DeFlow/ledger`'s, the
 * migration backup is `migrate()`'s, reaping is the reaper's, the bind and the
 * token are `boot()`'s — and what this file adds is the *sequence*, the
 * *timings* and the *sentences*. Those three are what an operator actually
 * meets, and they are what this story's acceptance criteria are about.
 *
 * Two of the eight steps belong to the CLI rather than to `boot()`, and both
 * sit outside it for a reason:
 *
 * - `pick-port` runs **first**, because a pinned `--port` that is occupied must
 *   fail before anything has been leased, migrated or written (EPIC-18-S10),
 *   and because the port the daemon binds has to be chosen exactly once — the
 *   printed URL, `daemon.json` and `DeFlow status` all read that one answer
 *   rather than re-deriving 7777 (EPIC-18-S9).
 * - `open-browser` runs **last**, after the URL has been printed, so a machine
 *   with no `xdg-open` still hands the operator a URL they can click.
 */
import type { Clock } from '@DeFlow/core';
import {
  type Booted,
  boot,
  daemonFilePath,
  EX_ALREADY_RUNNING,
  PortInUse,
  type ProviderDetectionEntry,
  pickPort,
  probeProvidersOnBoot,
  type ReapDecision,
  resolveDataDir,
  systemClock,
} from '@DeFlow/daemon';
import { DaemonAlreadyRunning, type Migration } from '@DeFlow/ledger';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { openBrowser } from './open-browser.ts';

/**
 * The eight steps `--timings` reports (AC2).
 *
 * `boot()`'s own six in the middle, in `BOOT_STEPS` order — which is asserted
 * by KAR-03.7's spec and is not this story's to reorder — with the CLI's two
 * around them. The runbook's §9 lists its eight in a slightly different order
 * (it puts the lock after the migration); `boot()`'s order is the corrected
 * one, and the reason is written down in boot.ts: a second daemon that has
 * already opened the ledger has contended for the write lock the lease exists
 * to make unnecessary.
 */
export const UP_STEPS = [
  'pick-port',
  'resolve-data-dir',
  'lease',
  'migrate',
  'reap-orphans',
  'probe-providers',
  'bind-port',
  'open-browser',
] as const;

export type UpStep = (typeof UP_STEPS)[number];

export interface UpStepTiming {
  readonly step: UpStep;
  /** Wall-clock milliseconds this step took, read off the injected `Clock`. */
  readonly ms: number;
}

/** What `DeFlow up`'s flags mean, once parsed. */
export interface UpArgs {
  /** The operator's `--port`, or `null` for "7777, or the next free one". */
  readonly port: number | null;
  readonly timings: boolean;
  /** False for `--no-open`. */
  readonly open: boolean;
}

export type ParsedUpArgs =
  | { readonly ok: true; readonly args: UpArgs }
  | { readonly ok: false; readonly message: string };

/** The highest port number there is. A `--port` above it can never bind. */
const MAX_PORT = 65_535;

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= MAX_PORT ? port : null;
}

/**
 * `DeFlow up`'s argv, with an unknown flag treated as a refusal rather than as
 * noise.
 *
 * Ignoring an unrecognised flag is how `--detach` silently does nothing and the
 * operator concludes the daemon is broken; naming it costs one line.
 */
export function parseUpArgs(argv: readonly string[]): ParsedUpArgs {
  let port: number | null = null;
  let timings = false;
  let open = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    // KAR-18.9 AC7 — accepted and *consumed* here, never acted on: the styling
    // decision is `bin.ts`'s, computed once for the whole process. A parser
    // that refused this flag would make "--no-color works everywhere" false
    // for four of the five commands.
    if (argument === '--no-color') continue;

    if (argument === '--timings') {
      timings = true;
      continue;
    }
    if (argument === '--no-open') {
      open = false;
      continue;
    }
    if (argument === '--port' || argument.startsWith('--port=')) {
      const raw = argument.startsWith('--port=') ? argument.slice('--port='.length) : argv[++index];
      const parsed = parsePort(raw);
      if (parsed === null) {
        return {
          ok: false,
          message:
            `DeFlow up: --port needs a port number between 1 and ${MAX_PORT}; got ` +
            JSON.stringify(raw ?? ''),
        };
      }
      port = parsed;
      continue;
    }

    return {
      ok: false,
      message: `DeFlow up: unknown option ${JSON.stringify(argument)}`,
    };
  }

  return { ok: true, args: { port, timings, open } };
}

/** The width the step column is padded to, so the numbers line up. */
const STEP_COLUMN = Math.max(...UP_STEPS.map((step) => step.length), 'total'.length) + 2;

/**
 * `--timings`, rendered (AC2).
 *
 * Per step **and** a total, because the two answer different questions: the
 * total is NF3's 3-second budget, and the per-step numbers are what turn "cold
 * start regressed" into one line of output rather than an afternoon. The total
 * is measured across the whole command rather than summed from the steps, so
 * time spent between them cannot hide in the gap.
 */
export function renderTimings(timings: readonly UpStepTiming[], totalMs: number): string {
  const lines = timings.map(
    (timing) => `  ${timing.step.padEnd(STEP_COLUMN)}${String(timing.ms).padStart(5)} ms`,
  );
  return [
    'DeFlow up: timings',
    ...lines,
    `  ${'total'.padEnd(STEP_COLUMN)}${String(totalMs).padStart(5)} ms`,
    '',
  ].join('\n');
}

/**
 * The sentence a second `DeFlow up` prints (AC3, EPIC-18-S8).
 *
 * The pid comes from the lease's own holder file and the port from
 * `daemon.json`, so both name the *live* daemon rather than anything this
 * process invented. The URL carries **no token**: it goes into a terminal
 * scrollback that the handoff URL deliberately stays out of, and the browser
 * that already has the token is the one the operator is being sent back to.
 *
 * A `null` port is honest rather than fatal — a daemon that holds the lease but
 * has not written its file yet is a real, if brief, state — and the sentence
 * drops the half it cannot back up instead of printing `port null`.
 */
export function alreadyRunningMessage(live: {
  readonly pid: number | null;
  readonly port: number | null;
}): string {
  const who = `pid ${live.pid ?? 'unknown'}`;
  if (live.port === null) {
    return `DeFlow up: another DeFlowd is already running (${who}) — run 'DeFlow status'`;
  }
  return (
    `DeFlow up: another DeFlowd is already running (${who}, port ${live.port}) — open ` +
    `http://127.0.0.1:${live.port} or run 'DeFlow status'`
  );
}

export type { Clock };
/** Re-exported so `bin.ts` can name the refusal without importing the ledger. */
export { DaemonAlreadyRunning };

/**
 * The exit code for a boot that could not complete — a migration that failed,
 * a data directory that cannot be written.
 *
 * sysexits' `EX_SOFTWARE`, and deliberately not 2: 2 is "another daemon is
 * already running" or "your port is taken", both of which are *your machine's*
 * state and both of which a script may reasonably retry. This one is not.
 */
export const EX_BOOT_FAILED = 70;

export interface UpOptions {
  /** Defaults to `process.env`. `PATH`, `BROWSER`, `XDG_DATA_HOME` and
   * `DeFlow_DATA_DIR` are all read from here and nowhere else. */
  readonly env?: NodeJS.ProcessEnv;
  /** The operator's `--port`; `null` (the default) means 7777 or next free. */
  readonly port?: number | null;
  /** Step 8. False for `--no-open`. */
  readonly open?: boolean;
  readonly timings?: boolean;
  /** Time enters here and nowhere else (NF9) — including the step durations. */
  readonly clock?: Clock;
  /** Test seam; see `BootOptions.migrations`. */
  readonly migrations?: readonly Migration[];
}

export interface StartedUp {
  readonly kind: 'started';
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: '';
  readonly dataDir: string;
  /** The port actually bound — the one `daemon.json` and the URL both carry. */
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly epoch: number;
  readonly providers: readonly ProviderDetectionEntry[];
  readonly reaped: readonly ReapDecision[];
  readonly timings: readonly UpStepTiming[];
  readonly daemon: Booted;
  /** Idempotent: the second call is a no-op, so a signal handler and a spec's
   * cleanup can both call it. */
  stop(): Promise<void>;
}

export interface RefusedUp {
  readonly kind: 'refused';
  readonly exitCode: number;
  readonly stdout: '';
  readonly stderr: string;
}

export type UpResult = StartedUp | RefusedUp;

/** The live daemon's port, out of its own file, or `null` if it has not
 * written one yet. Never invented, and never re-derived from 7777. */
function livePort(dataDir: string): number | null {
  try {
    const file: unknown = JSON.parse(readFileSync(daemonFilePath(dataDir), 'utf8'));
    const port = (file as { port?: unknown }).port;
    return typeof port === 'number' ? port : null;
  } catch {
    return null;
  }
}

/** Six lowercase hex characters for the probe's synthetic run id. */
const randomHex = (): string => randomBytes(3).toString('hex');

/**
 * What step 4 found, as the operator reads it (AC8, EPIC-18-S15).
 *
 * The zero case is the one that had to be designed rather than formatted. A
 * fresh laptop with nothing but node, git and a browser is the first-contact
 * experience for every colleague, and the failure it guards against is the
 * opaque one — a crash inside a provider probe saying `ENOENT: spawn claude`,
 * which tells the operator nothing about what to do. So: how many are usable,
 * what to run to install each one that is not, and the fact that the bundled
 * mock agent and `DeFlow replay` need no provider at all.
 */
function renderProviders(entries: readonly ProviderDetectionEntry[]): string {
  const usable = entries.filter(
    (entry) => entry.status === 'detected' || entry.status === 'cached',
  );
  const lines = [`DeFlow up: ${usable.length} providers available`];

  for (const entry of entries) {
    lines.push(
      entry.version === null
        ? `  ${entry.provider}: ${entry.detail}`
        : `  ${entry.provider} ${entry.version} (${entry.status})`,
    );
  }

  if (usable.length === 0) {
    lines.push(
      '  nothing above is installed, which is not a failure: the bundled DeFlow-mock-agent runs',
      "  a whole plan with no vendor CLI, and 'DeFlow replay <fixture>' serves a recorded run over",
      '  the same HTTP contract the UI speaks to a live one.',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * `DeFlow up` — the whole command, minus the process it runs in.
 *
 * Returns rather than exits, and never writes to a stream itself: `bin.ts`
 * owns the process, and a function that called `process.exit` could not be
 * tested without one. The daemon it started is handed back so its caller can
 * hold it open, and `stop()` is the graceful shutdown a signal handler runs.
 */
export async function runUp(options: UpOptions = {}): Promise<UpResult> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const dataDir = resolveDataDir(env);

  const timings: UpStepTiming[] = [];
  const startedAt = clock.now();
  let mark = startedAt;
  const took = (step: UpStep): void => {
    const now = clock.now();
    timings.push({ step, ms: now - mark });
    mark = now;
  };

  // ── 1. the port, chosen exactly once ───────────────────────────────────────
  let port: number;
  try {
    port = await pickPort({ requested: options.port ?? undefined });
  } catch (error) {
    if (error instanceof PortInUse) {
      return {
        kind: 'refused',
        exitCode: EX_ALREADY_RUNNING,
        stdout: '',
        stderr: `${error.message}\n`,
      };
    }
    throw error;
  }
  took('pick-port');

  // ── 2–7. the daemon itself ─────────────────────────────────────────────────
  let daemon: Booted;
  try {
    daemon = await boot({
      dataDir,
      port,
      dev: false,
      ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
      onStep: (step) => took(step),
      probeProviders: ({ db, dataDir: dir }) =>
        probeProvidersOnBoot({ db, clock, dataDir: dir, env, randomHex }),
    });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunning) {
      // AC3 — the sentence, with the live daemon's own pid and port. Nothing
      // was leased, opened or bound to get here, so `daemon.json` and
      // `daemon_epoch` both still belong to the daemon that is running.
      return {
        kind: 'refused',
        exitCode: EX_ALREADY_RUNNING,
        stdout: '',
        stderr: `${alreadyRunningMessage({ pid: error.pid, port: livePort(dataDir) })}\n`,
      };
    }
    // AC5 — a migration that failed, most likely. One sentence, no stack
    // trace, and nothing is serving: `boot` released the lease on its way out.
    return {
      kind: 'refused',
      exitCode: EX_BOOT_FAILED,
      stdout: '',
      stderr: `DeFlow up: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  // ── 8. the URL, then the browser ───────────────────────────────────────────
  //
  // Printed before the browser is launched, and printed whether or not one is:
  // a machine with no `xdg-open` still leaves the operator a URL to click.
  let stdout = `${renderProviders(daemon.providers)}${daemon.url}\n`;

  if (options.open === true) {
    openBrowser(daemon.url, { platform: process.platform, env }, (error) => {
      stdout += `DeFlow up: could not open a browser (${error.message}); open the URL above\n`;
    });
  }
  took('open-browser');

  if (options.timings === true) stdout += renderTimings(timings, clock.now() - startedAt);

  let stopped = false;
  return {
    kind: 'started',
    exitCode: 0,
    stdout,
    stderr: '',
    dataDir,
    port: daemon.port,
    token: daemon.token,
    url: daemon.url,
    epoch: daemon.epoch,
    providers: daemon.providers,
    reaped: daemon.reaped,
    timings,
    daemon,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await daemon.shutdown();
    },
  };
}
