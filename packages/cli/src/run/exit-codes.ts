/**
 * KAR-18.3 AC6 — `DeFlow run`'s exit codes, derived in exactly one place.
 *
 * *"Exit codes are the CLI's API for CI"* (EPIC-18-S23), which makes this the
 * smallest file in the command and the one with the most callers. The test
 * plan's red for it is not a wrong number, it is a *second* number: _"exit code
 * is derived at three call sites and they disagree on `paused`"_. So there is
 * one function, it takes a reduced `RunState`, and every other module in
 * `./` asks it rather than branching on `state.status` itself.
 *
 * Two of the seven codes are not derivable from a run at all — a daemon that
 * refused to start (2) and a machine that cannot host one (5) are facts about
 * the environment, and the run they would have driven does not exist yet — so
 * they live in the table and not in `classifyRun`.
 *
 * The `paused` row is the one worth reading twice. A ceiling breach is **3 and
 * not 1** because [F4.6](../../../../docs/prd.md) is explicit that hitting a
 * ceiling pauses for a human decision rather than failing; collapsing it into
 * "failure" would train the operator to ignore it. And a run paused by a
 * *person* is not terminal at all: somebody is going to resume it, and a CLI
 * that exited would be answering a question nobody asked.
 *
 * Verifies: EPIC-18-S23 · AC6
 */
import { isRunRefusalCode } from '@DeFlow/adapters';
import type { RunState } from '@DeFlow/core';
import { openHumanGates } from '@DeFlow/core';

/**
 * The closed set. Seven codes, documented in `bin.ts`'s usage text and asserted
 * to be exactly these seven by `./exit-codes.test.ts`.
 */
export const RUN_EXIT_CODES = {
  /** Completed with every gate passed. */
  completed: 0,
  /** Completed with a failed gate, or with a node that failed for good. */
  failed: 1,
  /** The daemon refused: another one holds the lease, or the port is taken. */
  daemonRefused: 2,
  /** Paused on a budget ceiling — a decision to make, not a failure (F4.6). */
  budgetPaused: 3,
  /** Waiting on a human gate, under `--no-wait`. */
  awaitingHuman: 4,
  /** This machine cannot host a run: git too old, state directory unwritable. */
  environmentUnusable: 5,
  /** Interrupted — the operator pressed Ctrl-C. */
  interrupted: 130,
} as const;

export type RunExitCode = (typeof RUN_EXIT_CODES)[keyof typeof RUN_EXIT_CODES];

/**
 * sysexits(3) `EX_USAGE` — deliberately **not** a member of the table above.
 *
 * A bad argv is not a run outcome. `RUN_EXIT_CODES` is the closed set of codes a
 * *run* can end with, and `./exit-codes.test.ts` asserts it stays exactly seven;
 * folding 64 into it would make "the run finished" and "you typed the flag
 * wrong" the same kind of answer. It lives here rather than beside its callers
 * because `cancel.ts` and the run command must exit the same code for the same
 * mistake, and two `const EX_USAGE = 64` declarations are two things to keep
 * true. A CI job branching on the seven codes should never see it for a run
 * that started.
 */
export const EX_USAGE = 64;

/**
 * KAR-19.2 AC5 — what `DeFlow run` exits when `POST /api/runs` refused it.
 *
 * Two of the refusal codes are facts about the *machine* rather than about the
 * request: no provider on it can serve a run, or the one bridge it has does not
 * speak ACP. Both are `environmentUnusable`, which is already documented as
 * *"this machine cannot host a run"* and is already what this command exits
 * when git is too old — the same class of fact, discovered one step earlier.
 * Everything else the daemon refuses is a request that was wrong, which is 64.
 *
 * The table gains no eighth member, and `isRunRefusalCode` is the closed
 * vocabulary from `@DeFlow/adapters` rather than two string literals repeated
 * here — the daemon and the CLI must agree on which codes these are, and a
 * copy is a way for them to stop agreeing.
 */
export function rejectionExitCode(code: string | null): number {
  return code !== null && isRunRefusalCode(code) ? RUN_EXIT_CODES.environmentUnusable : EX_USAGE;
}

export interface RunVerdict {
  /** Whether the CLI should stop watching. `false` means "still going". */
  readonly terminal: boolean;
  /** Meaningless unless `terminal`; the code the process exits with. */
  readonly exitCode: number;
  /** The final line's one sentence. No newline, no trailing full stop. */
  readonly reason: string;
}

export interface ClassifyOptions {
  /** `--no-wait`: an open human gate becomes a terminal 4 instead of a wait. */
  readonly noWait: boolean;
}

const WATCHING: RunVerdict = { terminal: false, exitCode: 0, reason: '' };

/** The first gate whose verdict is not a pass, in `seq` order. */
function failedGate(state: RunState): { gate: string; outcome: string } | null {
  const failures = Object.values(state.gateVerdicts)
    .filter((verdict) => verdict.outcome !== 'pass')
    .toSorted((left, right) => left.seq - right.seq);
  const first = failures[0];
  return first === undefined ? null : { gate: first.gate, outcome: first.outcome };
}

/** The first node the ledger says failed, by the seq that last moved it. */
function failedNode(state: RunState): string | null {
  const failures = Object.entries(state.nodes)
    .filter(([, node]) => node.status === 'failed')
    .toSorted((left, right) => left[1].updatedSeq - right[1].updatedSeq);
  return failures[0]?.[0] ?? null;
}

/** The run-scope ceiling this run tripped, if it tripped one. */
function runCeilingBreach(
  state: RunState,
): { dimension: string; limit: number; actual: number } | null {
  const breach = state.budget.breaches.find((candidate) => candidate.scope === 'run');
  return breach === undefined
    ? null
    : { dimension: breach.dimension, limit: breach.limit, actual: breach.actual };
}

/** What a run that has ended is worth, as an exit code and a sentence. */
function classifyEnded(state: RunState): RunVerdict {
  const gate = failedGate(state);
  if (gate !== null) {
    return {
      terminal: true,
      exitCode: RUN_EXIT_CODES.failed,
      reason: `completed — the ${gate.gate} gate ${gate.outcome === 'fail' ? 'failed' : 'needs a human'}`,
    };
  }

  const node = failedNode(state);
  if (node !== null) {
    return {
      terminal: true,
      exitCode: RUN_EXIT_CODES.failed,
      reason: `completed — node ${node} failed`,
    };
  }

  if (state.outcome !== null && state.outcome !== 'succeeded') {
    return {
      terminal: true,
      exitCode: RUN_EXIT_CODES.failed,
      reason: `completed — the run ended ${state.outcome}`,
    };
  }

  return {
    terminal: true,
    exitCode: RUN_EXIT_CODES.completed,
    reason: 'completed — every gate passed',
  };
}

/**
 * The one derivation of `DeFlow run`'s exit code.
 *
 * `terminal: false` is not an error state — it is the answer for every run that
 * is still going, and it is what keeps the watcher watching rather than
 * inventing a code for "not finished yet".
 */
export function classifyRun(state: RunState, options: ClassifyOptions): RunVerdict {
  switch (state.status) {
    case 'completed':
      return classifyEnded(state);

    case 'aborted':
      return {
        terminal: true,
        exitCode: RUN_EXIT_CODES.interrupted,
        reason: 'aborted — the run was cancelled',
      };

    case 'paused': {
      const breach = runCeilingBreach(state);
      if (breach === null) return WATCHING;
      return {
        terminal: true,
        exitCode: RUN_EXIT_CODES.budgetPaused,
        reason: `paused — the run ${breach.dimension} ceiling of ${breach.limit} was reached at ${breach.actual}`,
      };
    }

    case 'awaiting-spec-approval':
      return options.noWait
        ? {
            terminal: true,
            exitCode: RUN_EXIT_CODES.awaitingHuman,
            reason: 'waiting — the spec approval gate is open and --no-wait was given',
          }
        : WATCHING;

    case 'needs-human':
      return options.noWait
        ? {
            terminal: true,
            exitCode: RUN_EXIT_CODES.awaitingHuman,
            reason: `waiting — the run needs a human (${state.needsHuman?.reason ?? 'unspecified'})`,
          }
        : WATCHING;

    default: {
      // A `human` node gate mid-run is the same wait as the spec gate, and it
      // is a property of the projection rather than of `status`: a run whose
      // status is still `running` can have a blocking gate open on one node.
      const [open] = openHumanGates(state);
      if (open !== undefined && options.noWait) {
        return {
          terminal: true,
          exitCode: RUN_EXIT_CODES.awaitingHuman,
          reason: `waiting — node ${open.node} is asking a human and --no-wait was given`,
        };
      }
      return WATCHING;
    }
  }
}
