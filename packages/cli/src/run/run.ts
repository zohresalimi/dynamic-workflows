/**
 * `deflow run` (KAR-18.3) — the whole command, minus the process it runs in.
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
import { PROVIDER_SPECS, resolveProviderStates, usableProviders } from '@DeFlow/adapters';
import type { Clock, Event, RunId, RunState } from '@DeFlow/core';
import {
  announceProviderChoice,
  initialRunState,
  pendingGate,
  RunIdSchema,
  reduce,
} from '@DeFlow/core';
import {
  checkGitVersion,
  EX_ALREADY_RUNNING,
  pathRoots,
  resolveDataDir,
  systemClock,
} from '@DeFlow/daemon';
import process from 'node:process';
import { createRun, type FollowRunResult, followRun, RunTaskRejected } from '../index.ts';
import type { Screen } from '../render/screen.ts';
import { createStyle, type Style } from '../render/style.ts';
import type { ProviderChoice, RunArgs } from './args.ts';
import { parseRunArgs } from './args.ts';
import { cancelRun } from './cancel.ts';
import { type DaemonEndpoint, ensureDaemon } from './daemon.ts';
import {
  classifyRun,
  EX_USAGE,
  RUN_EXIT_CODES,
  type RunVerdict,
  rejectionExitCode,
} from './exit-codes.ts';
import { createInterrupt } from './interrupt.ts';
import { followNodeOutput, type IoFollower } from './io-follow.ts';
import { createRenderer, type RunRenderer } from './render.ts';
import { applyIntent, applyTyping } from './session/actions.ts';
import { createCancelSession } from './session/cancel.ts';
import { liveViewDecision } from './session/degrade.ts';
import { createGateSession, type GateSession } from './session/gate.ts';
import { createInterjectSession } from './session/interject.ts';
import type { Keyboard, KeyboardRequest } from './session/keyboard.ts';
import { withKeyboard } from './session/keyboard.ts';
import { createSession, type Session } from './session/session.ts';
import { DEFAULT_ROWS, initialSessionState, type SessionState } from './session/state.ts';

// KAR-18.3 AC3's contract moved to `./interrupt.ts` so KAR-21.2's decoded
// Ctrl-C and this command's SIGINT handler share **one** implementation rather
// than two that agree today. Re-exported because it is part of this module's
// published surface and moving a file is not a reason to break a caller.
export { DETACH_WINDOW_MS, detachSentence } from './interrupt.ts';

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
  /**
   * KAR-21.2 AC3 — whether the **input** is a terminal. Decided once by
   * `bin.ts`, passed, never re-derived here.
   *
   * A separate decision from `isTty`, which is about output, and the two really
   * do differ: `deflow run | less` has a keyboard and no output terminal, and
   * `deflow run < /dev/null` from a shell has the reverse. Absent means no
   * keyboard, which is the safe answer — `setRawMode` on a pipe throws, so an
   * omitted flag must not be able to reach it.
   */
  readonly stdinIsTty?: boolean | undefined;
  /**
   * KAR-21.2 AC3 — opens the keyboard, or is absent.
   *
   * A **factory** for the reason `openScreen` is one: AC6's claim is that on a
   * pipe no keyboard is *constructed*, and a spec can only observe that if
   * constructing one is something this file decides to do. It is called only
   * when there is a screen to act on and `stdinIsTty` is true.
   */
  readonly openKeyboard?: ((request: KeyboardRequest) => Keyboard) | undefined;
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
  /**
   * KAR-21.1 AC8 — opens the region the live frame is drawn in, or is absent.
   *
   * A **factory** rather than a `Screen`, because the claim AC8 makes is that
   * on a pipe no screen is *constructed* — which a spec can only observe if
   * constructing one is something this file decides to do. `bin.ts` passes one
   * that writes to `process.stdout`; a spec passes one that records.
   *
   * It is called only when stdout is a terminal and `--json` was not given.
   * `--json`'s consumer is a parser, and a repaint is not something a parser
   * can be asked to skip.
   */
  readonly openScreen?: (() => Screen) | undefined;
  /**
   * The terminal's height, for AC7's row budget — passed, never derived, for
   * the same reason `Style.width` is (KAR-18.9 AC7).
   */
  readonly terminalRows?: number | undefined;
  /**
   * KAR-21.5 AC4 — registers a SIGWINCH handler and returns its deregistration.
   *
   * The handler is given the **new `Style`**, computed by `render/style.ts`,
   * rather than a width this file would have to turn into one. That is the
   * whole of AC4's second half: the width comes from the one place that derives
   * it, on a resize exactly as at startup, and no module under `run/session/`
   * ever sees `stdout.columns`.
   *
   * Absent means the frame keeps the size it started at — which is what a spec
   * driving `runRun` in-process wants, and what a terminal that never changes
   * size gets anyway.
   */
  readonly onResize?:
    | ((handler: (style: Style, rows: number | undefined) => void) => () => void)
    | undefined;
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

/**
 * AC6's fifth code, and the only check this command makes about the machine.
 *
 * `deflow doctor` is the command that reports on an environment in full; what
 * belongs here is the one prerequisite a run cannot start without, because
 * every worktree it will create needs it. Anything more would be a second
 * doctor that drifts from the first.
 */
async function environmentUnusable(env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  const git = await checkGitVersion(env, cwd);
  if (git.status !== 'fail') return null;
  return `deflow run: ${git.message} Run 'deflow doctor' for the whole picture.`;
}

/**
 * KAR-19.10 AC1 — every registered provider, and whether this machine can serve
 * it, for the message a mistyped `--provider` gets.
 *
 * Both halves in one place because they answer one question, and both derived:
 * the ids come from `PROVIDER_SPECS` so a registry entry changes the message
 * with no other edit, and "usable" is `usableProviders` over the operator's own
 * `PATH` — the same reduction admission makes, not a second guess at it. This
 * is a read of the filesystem and is why it lives here rather than in the
 * parser, which stays a pure function of its arguments.
 */
function providerChoices(env: NodeJS.ProcessEnv): readonly ProviderChoice[] {
  const usable = new Set(
    usableProviders(resolveProviderStates(pathRoots(env))).map((entry) => entry.provider),
  );
  return Object.keys(PROVIDER_SPECS)
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({ id, usable: usable.has(id) }));
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
  /** KAR-19.12 AC3 — where a `--json` gate announcement goes. @see `render.ts` */
  readonly stderr: (chunk: string) => void;
  readonly noWait: boolean;
  readonly onFollowing: (following: FollowRunResult) => void;
  /** KAR-19.4 AC3 — every control event is offered here too, so the agent's
   * own bytes reach the terminal while its node is still running. */
  readonly io: IoFollower;
  /**
   * KAR-21.1 — the reduced state after each event, for the live frame. The
   * projection is folded here already; a second fold would be a second answer.
   *
   * KAR-21.4 AC2 — and the `seq` it was folded at, which is the cursor an
   * interjection is written against. It is this loop's `rendered` rather than a
   * second count, because *"the seq this session last rendered"* has to be the
   * same number as the one this line was rendered from.
   */
  readonly onState?: ((state: RunState, seq: number) => void) | undefined;
}): Promise<Watched> {
  let state = initialRunState();
  let rendered = 0;
  /** The gate this view has already announced, so a re-delivered event does not
   * announce it twice and a second gate still does. */
  let announcedGate: string | null = null;

  return await new Promise<Watched>((resolve, reject) => {
    let settled = false;
    const apply = (event: Event): void => {
      if (settled || event.seq <= rendered) return;
      rendered = event.seq;
      state = reduce(state, event);
      options.stdout(options.renderer.event(event));
      options.io.onEvent(event);

      // KAR-19.12 AC1, AC3 — a run that has stopped to ask says so, here, and
      // **before** the verdict is asked for: under `--no-wait` the very next
      // line settles the promise and the process exits, and a CI log that exits
      // 4 saying nothing is the same silence one level up.
      //
      // Derived from the reduced state through `pendingGate` rather than by
      // matching `human.requested` here, which is AC1's *one reader* clause as
      // code: the answered case, the second-gate case and the re-delivery case
      // are all already correct in the projection.
      const gate = pendingGate(state);
      if (gate !== null && gate.node !== announcedGate) {
        announcedGate = gate.node;
        const announcement = options.renderer.gate(gate);
        if (announcement.stdout !== '') options.stdout(announcement.stdout);
        if (announcement.stderr !== '') options.stderr(announcement.stderr);
      } else if (gate === null) {
        announcedGate = null;
      }

      options.onState?.(state, event.seq);

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
  /** KAR-19.10 AC4 — what the daemon said it chose, off the 201. */
  let announced: NonNullable<Awaited<ReturnType<typeof createRun>>['provider']> | null = null;
  if (args.attach !== null) {
    runId = RunIdSchema.parse(args.attach);
  } else if (args.input !== null) {
    try {
      const created = await createRun(args.input, {
        baseUrl: endpoint.baseUrl,
        token: endpoint.token,
        cwd: options.cwd,
        permission: args.permission,
        ...(args.provider === null ? {} : { provider: args.provider }),
      });
      runId = RunIdSchema.parse(created.runId);
      announced = created.provider ?? null;
    } catch (error) {
      if (error instanceof RunTaskRejected) {
        const exitCode = rejectionExitCode(error.code);
        // KAR-19.2 AC5, AC8 — an admission refusal is printed as the daemon
        // wrote it and nothing else: it is already several sentences of
        // `doctor`'s own words, and prefixing it with a field name that does
        // not exist would put a phantom request problem in front of a machine
        // problem. The attached view never opens, because there is nothing
        // left to watch — which is the whole of "the CLI's attached view stops
        // rather than waiting".
        options.stderr(
          exitCode === EX_USAGE
            ? `deflow run: ${error.field}: ${error.message}\n`
            : `${error.message}\n`,
        );
        return exitCode;
      }
      throw error;
    }
  } else {
    // `parseRunArgs` cannot produce this; the type can.
    options.stderr('deflow run: nothing to run\n');
    return EX_USAGE;
  }

  const renderer = createRenderer({
    mode: args.json ? 'json' : 'human',
    isTty: options.isTty,
    runId,
    // KAR-19.12 AC2 — the daemon this command actually reached, so the URL a
    // gate block prints goes to the port `deflow up` bound rather than to 7777.
    baseUrl: endpoint.baseUrl,
    ...(options.style === undefined ? {} : { style: options.style }),
  });

  /**
   * KAR-21.1 AC8, KAR-21.5 AC1, AC3, AC7 — the live region, or nothing at all.
   *
   * The four conditions are `liveViewDecision`'s rather than four guards here,
   * because a guard at a call site is how a fallback stops being a fallback:
   * the day a fifth condition is added, the place that was missed is a terminal
   * filling with literal escape text. What this file still owns is the one
   * condition that is about *this* invocation rather than about the terminal —
   * whether the caller handed over a way to open a screen at all.
   */
  const rows = options.terminalRows ?? DEFAULT_ROWS;
  const live = liveViewDecision({
    isTty: options.isTty(),
    json: args.json,
    env: options.env,
    rows,
  });
  const screen = live.live && options.openScreen !== undefined ? options.openScreen() : null;
  const session: Session | null =
    screen === null
      ? null
      : createSession({
          screen,
          stdout: options.stdout,
          style: options.style ?? createStyle({ isTty: false, env: {} }),
          // KAR-21.5 AC6 — the repaint window is measured on the same clock
          // the elapsed times in the frame are (NF9). `systemClock.setTimer`
          // unrefs, which is exactly right here: a pending repaint must never
          // be the reason a finished command sits there with nothing to do.
          clock,
        });

  /**
   * AC6 — every transcript byte in this command goes through here.
   *
   * With no session it *is* `options.stdout`, so the non-interactive path is
   * not merely equivalent to what it was, it is the same function. With one, it
   * is the erase-write-repaint sandwich, and the bytes in the middle are
   * untouched.
   */
  const out = session === null ? options.stdout : (chunk: string) => session.write(chunk);

  /**
   * KAR-21.2 AC3 — whether this invocation has a keyboard at all.
   *
   * Decided **once**, here, from three facts this file already owns: there is a
   * frame for keys to act on, the input is a terminal, and the caller handed
   * over a way to open one. Everything downstream reads this value rather than
   * asking again — `setRawMode` on a pipe throws, so a second derivation at a
   * call site is one forgotten guard away from `deflow run` dying at startup in
   * CI (AC6).
   */
  const hasKeyboard =
    session !== null && options.stdinIsTty === true && options.openKeyboard !== undefined;

  /** The session's own state, held here rather than in a module (AC9). */
  let sessionState: SessionState = {
    ...initialSessionState(),
    rows,
    keyboard: hasKeyboard,
  };
  /**
   * The last state the projection produced.
   *
   * Kept so a key press can repaint the frame without an event to hang it on —
   * opening the interjection row is a change to the session, not to the run, and
   * folding a second projection to find out what the run looked like would be
   * the second answer KAR-21.1 exists to avoid.
   */
  let lastRun: RunState = initialRunState();
  /**
   * KAR-21.4 AC2 — the seq this session last rendered.
   *
   * The cursor an interjection is written against, so the daemon can answer
   * `stale_cursor` when the node moved between the repaint and the keypress. It
   * moves only when an event was folded into the frame; a repaint caused by a
   * keypress leaves it where it was, because nothing new was read.
   */
  let lastSeq = 0;
  const repaint = (state: RunState, seq?: number): void => {
    lastRun = state;
    if (seq !== undefined) lastSeq = seq;
    session?.update(state, { ...sessionState, nowMs: clock.now() });
  };

  /**
   * KAR-21.5 AC3, AC7 — the step that could not be performed says so.
   *
   * One line, before anything about the run, so the operator who expected a
   * live region learns why in the same breath they stop seeing one. It is
   * `null` for the two refusals that must stay byte-silent — a pipe and
   * `--json` — which is what makes this line invisible to AC1's golden.
   */
  if (live.line !== null) out(`${live.line}\n`);

  if (!args.json) out(`run ${runId} — watching; Ctrl-C detaches\n`);

  /**
   * KAR-21.5 AC4 — the window the operator has now is the window the frame fits.
   *
   * The new `Style` arrives already computed by `render/style.ts`; nothing here
   * derives a width. `sessionState.rows` moves with it, because the row budget
   * is the other half of the same window and a frame laid out at the new width
   * against the old height would be right in one dimension.
   */
  const stopResize =
    session === null || options.onResize === undefined
      ? null
      : options.onResize((resized, resizedRows) => {
          sessionState = { ...sessionState, rows: resizedRows ?? sessionState.rows };
          session.resize(resized);
          repaint(lastRun);
        });

  // KAR-19.10 AC4 — before the first turn, and before anything is watched: one
  // line naming the provider, the resolved binary and the route. The sentence
  // is `announceProviderChoice`'s in both modes — under `--json` it goes out as
  // fields beside it, because nothing downstream should have to parse prose to
  // learn which agent a run is on.
  if (announced !== null) {
    out(
      args.json
        ? `${JSON.stringify({
            type: 'provider',
            runId,
            provider: announced.provider,
            binaryPath: announced.binaryPath,
            route: announced.route,
            ...(announced.limitation === null ? {} : { limitation: announced.limitation }),
          })}\n`
        : `${announceProviderChoice(announced)}\n`,
    );
    // AC7 — and what this machine will not be able to do, said now rather than
    // at the first agent node three minutes later.
    if (announced.limitation !== null && !args.json) {
      out(`${announced.limitation}\n`);
    }
  }

  // KAR-19.4 AC3 — the data plane, followed alongside the control plane. The
  // `io_chunk` table is deliberately not on the SSE stream (KAR-03.4), so a
  // command that only subscribed would render a perfect transcript of a
  // ten-minute node and show the operator nothing the agent said.
  const io = followNodeOutput({
    runId,
    baseUrl: endpoint.baseUrl,
    token: endpoint.token,
    onChunk: (node, chunk) => {
      out(renderer.io(node, chunk));
    },
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  let following: FollowRunResult | null = null;

  // KAR-18.3 AC3, and KAR-21.2 AC5: **one** implementation of what Ctrl-C means,
  // reached from both the signal and the decoded byte. In raw mode the terminal
  // stops turning Ctrl-C into SIGINT and sends 0x03 instead, so without this the
  // session would silently have removed the one interactive verb the command
  // already had — and with it, the session cannot add a third meaning even by
  // accident, because there is nowhere left to add one.
  const interrupt = createInterrupt({
    runId,
    out,
    stderr: options.stderr,
    closeStream: () => {
      following?.close();
    },
    cancel: () => cancelRun(runId, endpoint),
    sleep,
    ...(options.detachWindowMs === undefined ? {} : { windowMs: options.detachWindowMs }),
  });

  const removeSignal = (options.onInterrupt ?? defaultOnInterrupt)(() => {
    interrupt.press();
  });
  void interrupt.exitCode.then(removeSignal, removeSignal);

  /**
   * KAR-21.3 — the open gate's prompt, wired to the daemon this run is on.
   *
   * Constructed only where a key can reach it, for the same reason the keyboard
   * itself is: under `--json`, on a pipe and in CI nothing is selectable and no
   * key is read (AC9), so there is nothing here to have sent a request.
   *
   * It reads `lastRun` and `sessionState` through closures rather than being
   * handed a copy, because the projection moves under it — an answer arriving
   * from the browser while a keypress is in flight is safe in both orders only
   * because `pendingGate` over the *current* reduced state is the sole reader.
   */
  const gateSession: GateSession | null = hasKeyboard
    ? createGateSession({
        runId,
        endpoint,
        run: () => lastRun,
        state: () => sessionState,
        onState: (next) => {
          sessionState = next;
          repaint(lastRun);
        },
      })
    : null;

  /**
   * KAR-21.4 — the two verbs, wired to the same daemon and the same projection.
   *
   * Constructed only where a key can reach them, exactly as the gate prompt is:
   * under `--json`, on a pipe and in CI no key is read, so neither of these
   * exists to have sent anything (AC9).
   *
   * `cancelRun` is **handed in** rather than reached for, and it is the same
   * expression `createInterrupt` above was given — one client for the double
   * Ctrl-C, `deflow cancel` and this key, which is what AC7 asks for.
   */
  const interjectSession = hasKeyboard
    ? createInterjectSession({
        runId,
        endpoint,
        run: () => lastRun,
        state: () => sessionState,
        onState: (next) => {
          sessionState = next;
          repaint(lastRun);
        },
        lastSeq: () => lastSeq,
      })
    : null;

  const cancelSession = hasKeyboard
    ? createCancelSession({
        runId,
        state: () => sessionState,
        onState: (next) => {
          sessionState = next;
          repaint(lastRun);
        },
        cancel: () => cancelRun(runId, endpoint),
      })
    : null;

  /**
   * KAR-21.2 AC7 — one key, one decision, and no repaint when nothing changed.
   *
   * The reference comparison is the contract rather than an optimisation:
   * `applyIntent` returns the same object when an intent changes nothing, which
   * is how "an unrecognised key does nothing at all — no beep, no error line, no
   * repaint" is expressed as code a spec can observe.
   */
  // No second `openKeyboard !== undefined` test here: `hasKeyboard` already
  // carries it and TypeScript narrows through the alias. Repeating it would be
  // the re-derived decision AC3 forbids, wearing a redundant guard as a
  // disguise.
  const keyboard: Keyboard | null = hasKeyboard
    ? options.openKeyboard({
        // KAR-21.5 AC8 — the frame comes down wherever the terminal goes back,
        // which is the one place that covers the path a `finally` here cannot:
        // a fatal signal exits the process from inside the handler.
        onRestore: () => {
          // `session` is non-null wherever a keyboard exists — `hasKeyboard`
          // carries that — so this is the frame, unconditionally.
          session.close();
        },
        onIntent: (intent, text) => {
          // KAR-21.4 AC1 — a key that typed a character types it, while a row
          // is open. First, and ahead of every verb: `c` is the cancel key and
          // also a letter, and a correction containing one must not end the run
          // it was correcting. `applyTyping` returns the same object when no
          // row is open, so an unbound letter is still inert (KAR-21.2 AC7).
          if (text !== null) {
            const typed = applyTyping(sessionState, text);
            if (typed !== sessionState) {
              sessionState = typed;
              repaint(lastRun);
              return;
            }
          }
          // The two verbs claim what they can act on, then the gate, and
          // everything none of them claims falls through to the one
          // `SESSION_ACTIONS` table — so the arrows move between a gate's
          // options while the keyboard is aimed at one, and between regions when
          // it is not, without the tables having to agree about anything.
          if (interjectSession?.handle(intent) === true) return;
          if (cancelSession?.handle(intent) === true) return;
          if (gateSession?.handle(intent) === true) return;
          const outcome = applyIntent(sessionState, intent);
          if (outcome.effect === 'interrupt') interrupt.press();
          if (outcome.state !== sessionState) {
            sessionState = outcome.state;
            repaint(lastRun);
          }
        },
      })
    : null;

  const watched = watch({
    runId,
    endpoint,
    renderer,
    stdout: out,
    stderr: options.stderr,
    noWait: args.noWait,
    io,
    onState: repaint,
    onFollowing: (opened) => {
      following = opened;
      // A Ctrl-C that landed before the stream was open still detaches: the
      // press already printed its sentence, and this closes what it could not.
      if (interrupt.pressed()) opened.close();
    },
  }).then(async (result): Promise<number> => {
    following?.close();
    // The tail is drained before the verdict is printed: the last bytes of a
    // node are produced in the same instant as the event that ends it, and the
    // end of the output is the part that says what happened.
    await io.close();
    // KAR-21.2 AC4 — the terminal goes back **before** the verdict is written,
    // not after. Restoring last would print the run's last line through a
    // terminal the command had not finished borrowing.
    keyboard?.close();
    // AC6 — the frame comes down before the verdict goes out, so the last line
    // a run leaves behind is its verdict rather than a footer describing a run
    // that has already ended.
    session?.close();
    const totals = {
      costUsd: result.state.budget.run.costUsd,
      wallclockMs: clock.now() - startedAt,
    };
    const final = renderer.final(result.verdict, totals);
    if (final.stdout !== '') options.stdout(final.stdout);
    if (final.stderr !== '') options.stderr(final.stderr);
    return result.verdict.exitCode;
  });

  const settle = async (): Promise<number> =>
    await Promise.race([
      watched,
      // A detach or a cancel closes the tail too — the viewer is going, and a
      // poll left running would keep the process alive after its exit code was
      // decided.
      interrupt.exitCode.then(async (code) => {
        await io.close();
        keyboard?.close();
        session?.close();
        return code;
      }),
    ]);

  // KAR-21.2 AC4 — the restoration is registered in **one place** and covers the
  // paths above as well as the one none of them mention: a throw. `close` is
  // idempotent, so the early calls inside `settle` are the tidy path and this is
  // the guarantee. Without it a bug anywhere under here would leave the operator
  // with a shell that has no echo and no line editing.
  //
  // KAR-21.5 AC8 applies the same reasoning to the frame, which needed it: the
  // keyboard's `finally` covered the throw and the session's did not, so a bug
  // under here left the status region on screen and the shell prompt landed in
  // the middle of it. Both are idempotent, and the ordering is the one AC4
  // requires — the terminal goes back first, and only then is anything erased
  // through it.
  try {
    return keyboard === null ? await settle() : await withKeyboard(keyboard, settle);
  } finally {
    stopResize?.();
    session?.close();
  }
}

/**
 * `deflow run` — argv in, exit code out.
 *
 * The order of the three gates before any run exists is deliberate: the argv is
 * checked without touching the machine, the machine is checked without touching
 * the daemon, and the daemon is reached without creating anything. Each of the
 * three has its own code (64, 5, 2) and none of them can leave a half-born run
 * behind.
 */
export async function runRun(options: RunCommandOptions): Promise<number> {
  const parsed = parseRunArgs(options.argv, { providers: providerChoices(options.env) });
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
    // The same code a second `deflow up` exits with, and for the same reason:
    // this is your machine's state, and a script may reasonably retry it.
    return EX_ALREADY_RUNNING;
  }

  return await execute(parsed.args, options, lookup.endpoint);
}
