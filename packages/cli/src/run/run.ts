/**
 * `DeFlow run` (KAR-18.3) — the whole command, minus the process it runs in.
 *
 * The design constraint the epic states is that there is **no second protocol
 * implementation**: `hydrateRun`, `connectStream` and `createDispatcher` are
 * `@DeFlow/web`'s, the same modules the browser imports, reached through
 * `../index.ts`'s `followRun`. This file renders them to a terminal instead of
 * to Vue Flow and does nothing else with the wire. That also means the CLI has
 * **no `Last-Event-ID` mechanism at all** — nothing in a shell maintains one —
 * so `?since=<seq>` is its only resume path (AC5).
 *
 * Two behaviours here are surprising enough to be worth stating before the
 * code:
 *
 * **Ctrl-C detaches, it does not cancel.** The daemon owns execution and was
 * spawned into its own process group, so the terminal's SIGINT never reaches
 * it. Killing the viewer of a six-hour run should not kill the run — but a
 * person pressing Ctrl-C usually means "stop". So the first press says exactly
 * what it did and what the two alternatives are, and then waits three seconds:
 * a second press inside that window is the cancel they meant, and silence is
 * the detach they were told about. The process cannot exit on the first press
 * and still be able to hear a second one, which is why the window exists at
 * all rather than an immediate exit.
 *
 * **Everything is derived from the ledger.** The exit code is `classifyRun`
 * over the reduced `RunState` — one derivation, per AC6 — and the transcript is
 * a rendering of the same events the projection was folded from. There is no
 * second source of truth about how the run went, so a transcript that says
 * "completed" and an exit code that says otherwise is not representable.
 *
 * Returns an exit code rather than exiting: `bin.ts` owns the process, and a
 * function that called `process.exit` could not be tested without one.
 */
import type { Clock, Event, RunId, RunState } from '@DeFlow/core';
import { initialRunState, RunIdSchema, reduce } from '@DeFlow/core';
import { checkGitVersion, EX_ALREADY_RUNNING, resolveDataDir, systemClock } from '@DeFlow/daemon';
import process from 'node:process';
import { createRun, type FollowRunResult, followRun, RunTaskRejected } from '../index.ts';
import type { Style } from '../render/style.ts';
import type { RunArgs } from './args.ts';
import { parseRunArgs } from './args.ts';
import { cancelRun } from './cancel.ts';
import { type DaemonEndpoint, ensureDaemon } from './daemon.ts';
import { classifyRun, RUN_EXIT_CODES, type RunVerdict } from './exit-codes.ts';
import { createRenderer, type RunRenderer } from './render.ts';

/** sysexits(3) `EX_USAGE`, the same code a bad argv gets everywhere else here. */
const EX_USAGE = 64;

/** How long a second Ctrl-C has to arrive before the detach stands (AC3). */
export const DETACH_WINDOW_MS = 3_000;

export interface RunCommandOptions {
  /** Everything after `run`. */
  readonly argv: readonly string[];
  /** The repository the run executes against. */
  readonly cwd: string;
  /** `DeFlow_DATA_DIR`, `XDG_DATA_HOME` and `PATH` are read from here. */
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  /** Consulted per rendered line, never captured (AC7). */
  readonly isTty: () => boolean;
  /** KAR-18.9 — the width and charset half of the styling decision, computed
   * once by `bin.ts`. Absent means 80 columns and no colour. */
  readonly style?: Style;
  /** Time enters here and nowhere else (NF9) — the wall-clock total. */
  readonly clock?: Clock;
  /**
   * A **ref'd** wait, for the detach window and the health poll.
   *
   * `systemClock.setTimer` unrefs, which is right for a daemon whose ticker
   * must not hold the process open and wrong here: while the stream is closed
   * and this is the only thing outstanding, an unref'd timer would let Node
   * decide the process had finished and exit before the window was over.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Registers a Ctrl-C handler and returns the deregistration. Defaults to
   * `process.on('SIGINT')` — injected only so a spec can drive the double-tap
   * without a process.
   */
  readonly onInterrupt?: (handler: () => void) => () => void;
  /** Test seams for the autostart; see `./daemon.ts`. */
  readonly execPath?: string;
  readonly binPath?: string;
  readonly detachWindowMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultOnInterrupt = (handler: () => void): (() => void) => {
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
};

/** AC3's sentence, verbatim. Both alternatives, because detach-by-default is
 * surprising and a message that named only one would leave the operator
 * guessing about the other. */
export function detachSentence(runId: string): string {
  return (
    `detached — run ${runId} continues; 'DeFlow run --attach ${runId}' to watch, ` +
    `'DeFlow cancel ${runId}' to stop\n`
  );
}

/**
 * AC6's fifth code, and the only check this command makes about the machine.
 *
 * `DeFlow doctor` is the command that reports on an environment in full; what
 * belongs here is the one prerequisite a run cannot start without, because
 * every worktree it will create needs it. Anything more would be a second
 * doctor that drifts from the first.
 */
async function environmentUnusable(env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  const git = await checkGitVersion(env, cwd);
  if (git.status !== 'fail') return null;
  return `DeFlow run: ${git.message} Run 'DeFlow doctor' for the whole picture.`;
}

interface Watched {
  readonly verdict: RunVerdict;
  readonly state: RunState;
}

/**
 * Follows a run to a terminal state, rendering as it goes.
 *
 * The `seq > rendered` guard is AC5 stated as code: the contract is *strictly
 * greater than* the cursor, never `cursor + 1`, so a burned `AUTOINCREMENT`
 * value crosses without a word and a re-delivered event is rendered once.
 */
async function watch(options: {
  readonly runId: RunId;
  readonly endpoint: DaemonEndpoint;
  readonly renderer: RunRenderer;
  readonly stdout: (chunk: string) => void;
  readonly noWait: boolean;
  readonly onFollowing: (following: FollowRunResult) => void;
}): Promise<Watched> {
  let state = initialRunState();
  let rendered = 0;

  return await new Promise<Watched>((resolve, reject) => {
    let settled = false;
    const apply = (event: Event): void => {
      if (settled || event.seq <= rendered) return;
      rendered = event.seq;
      state = reduce(state, event);
      options.stdout(options.renderer.event(event));

      const verdict = classifyRun(state, { noWait: options.noWait });
      if (verdict.terminal) {
        settled = true;
        resolve({ verdict, state });
      }
    };

    followRun(options.runId, {
      baseUrl: options.endpoint.baseUrl,
      token: options.endpoint.token,
      onEvent: apply,
    }).then((following) => {
      options.onFollowing(following);
      // A run that was already over before the hydrate finished never emits
      // another event, so the verdict has to be asked for once more here.
      if (!settled) {
        const verdict = classifyRun(state, { noWait: options.noWait });
        if (verdict.terminal) {
          settled = true;
          resolve({ verdict, state });
        }
      }
    }, reject);
  });
}

/** Everything the command needs, once the argv has been believed. */
async function execute(
  args: RunArgs,
  options: RunCommandOptions,
  endpoint: DaemonEndpoint,
): Promise<number> {
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = clock.now();

  let runId: RunId;
  if (args.attach !== null) {
    runId = RunIdSchema.parse(args.attach);
  } else if (args.input !== null) {
    try {
      const created = await createRun(args.input, {
        baseUrl: endpoint.baseUrl,
        token: endpoint.token,
        cwd: options.cwd,
        permission: args.permission,
      });
      runId = RunIdSchema.parse(created.runId);
    } catch (error) {
      if (error instanceof RunTaskRejected) {
        options.stderr(`DeFlow run: ${error.field}: ${error.message}\n`);
        return EX_USAGE;
      }
      throw error;
    }
  } else {
    // `parseRunArgs` cannot produce this; the type can.
    options.stderr('DeFlow run: nothing to run\n');
    return EX_USAGE;
  }

  const renderer = createRenderer({
    mode: args.json ? 'json' : 'human',
    isTty: options.isTty,
    runId,
    ...(options.style === undefined ? {} : { style: options.style }),
  });
  if (!args.json) options.stdout(`run ${runId} — watching; Ctrl-C detaches\n`);

  let following: FollowRunResult | null = null;
  let presses = 0;

  const interrupted = new Promise<number>((resolve) => {
    const remove = (options.onInterrupt ?? defaultOnInterrupt)(() => {
      presses += 1;

      if (presses === 1) {
        // The viewer stops; the run does not. Printed before anything is
        // awaited, so the sentence is on screen while the window is open.
        options.stdout(detachSentence(runId));
        following?.close();
        void sleep(options.detachWindowMs ?? DETACH_WINDOW_MS).then(() => {
          if (presses === 1) {
            remove();
            resolve(RUN_EXIT_CODES.interrupted);
          }
        });
        return;
      }

      if (presses === 2) {
        void cancelRun(runId, endpoint)
          .then((outcome) => {
            options.stderr(`DeFlow run: ${outcome.message}\n`);
          })
          .finally(() => {
            remove();
            resolve(RUN_EXIT_CODES.interrupted);
          });
      }
    });
  });

  const watched = watch({
    runId,
    endpoint,
    renderer,
    stdout: options.stdout,
    noWait: args.noWait,
    onFollowing: (opened) => {
      following = opened;
      // A Ctrl-C that landed before the stream was open still detaches: the
      // press already printed its sentence, and this closes what it could not.
      if (presses > 0) opened.close();
    },
  }).then((result): number => {
    following?.close();
    const totals = {
      costUsd: result.state.budget.run.costUsd,
      wallclockMs: clock.now() - startedAt,
    };
    const final = renderer.final(result.verdict, totals);
    if (final.stdout !== '') options.stdout(final.stdout);
    if (final.stderr !== '') options.stderr(final.stderr);
    return result.verdict.exitCode;
  });

  return await Promise.race([watched, interrupted]);
}

/**
 * `DeFlow run` — argv in, exit code out.
 *
 * The order of the three gates before any run exists is deliberate: the argv is
 * checked without touching the machine, the machine is checked without touching
 * the daemon, and the daemon is reached without creating anything. Each of the
 * three has its own code (64, 5, 2) and none of them can leave a half-born run
 * behind.
 */
export async function runRun(options: RunCommandOptions): Promise<number> {
  const parsed = parseRunArgs(options.argv);
  if (!parsed.ok) {
    options.stderr(`${parsed.message}\n`);
    return EX_USAGE;
  }

  const unusable = await environmentUnusable(options.env, options.cwd);
  if (unusable !== null) {
    options.stderr(`${unusable}\n`);
    return RUN_EXIT_CODES.environmentUnusable;
  }

  const dataDir = resolveDataDir(options.env);
  const lookup = await ensureDaemon({
    dataDir,
    env: options.env,
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    ...(options.binPath === undefined ? {} : { binPath: options.binPath }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  if (lookup.kind === 'refused') {
    options.stderr(`${lookup.message}\n`);
    // The same code a second `DeFlow up` exits with, and for the same reason:
    // this is your machine's state, and a script may reasonably retry it.
    return EX_ALREADY_RUNNING;
  }

  return await execute(parsed.args, options, lookup.endpoint);
}
