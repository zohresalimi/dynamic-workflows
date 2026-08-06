/**
 * KAR-06.4 — the `shell` probe (docs/05-durable-execution.md §8.3).
 *
 * A shell command is not idempotent in general and no cleverness fixes that,
 * so the design does not try. It classifies the command **at plan time** and
 * accepts a different recovery story for each answer:
 *
 * - **`pure`** — test, lint, build, typecheck. Re-run it. The cost is time,
 *   and time is a cost this system is allowed to pay.
 * - **`mutating`** — migrations, publishes, network POSTs. Run it inside a
 *   dedicated worktree with a hash of `git status --porcelain` journalled
 *   before and after, and reconcile by re-hashing.
 *
 * The mutating table is three rows long and the third one is the honest one:
 *
 * | observed hash        | verdict       | why                                    |
 * | -------------------- | ------------- | -------------------------------------- |
 * | the **before** hash  | `not-started` | the world is as we left it; re-run     |
 * | the **after** hash   | `done`        | it landed; memoise the result          |
 * | neither              | `unknown`     | it half-ran, or something else moved   |
 *
 * `unknown` is not a bug to be fixed later (roadmap risk **A1-5**). Retrying
 * might apply a migration twice, skipping might drop it, and neither outcome
 * is detectable afterwards — so the probe says so and a human decides. See
 * ./escalate.ts.
 *
 * Verifies: EPIC-06-S12 (shell rows), EPIC-06-S15 · AC4, AC5
 */
import { contentHash } from '@DeFlow/core';

/**
 * Assigned when the plan is written, never inferred from the command string
 * at run time.
 *
 * Inferring it would mean a regex deciding whether `npm run deploy` mutates
 * anything, and being wrong in the direction that re-runs a publish.
 */
export type ShellClassification = 'pure' | 'mutating';

/**
 * What a `mutating` shell effect writes into its journal row **before** the
 * command is spawned, and completes the instant it returns.
 *
 * It lives in the effect row's `result_json` while the row is still `pending`
 * (see `scaffoldEffect` in @DeFlow/ledger) rather than in an event, because
 * reconcile reads it by ikey and nothing else ever needs it.
 */
export interface MutatingShellScaffold {
  readonly kind: 'shell.mutating';
  /** `git status --porcelain` hashed before `perform()`. Always present. */
  readonly before: string;
  /**
   * The same hash taken the moment the command returned, or `null` when the
   * daemon died before it could be written.
   *
   * `null` is the interesting value: it is the S16 window, and it is why a
   * mutating command that crashed mid-flight escalates instead of guessing.
   */
  readonly after: string | null;
  /** The result to memoise if the after-hash matches. */
  readonly result: unknown;
}

export type ShellReconcileVerdict =
  | { readonly status: 'not-started' }
  | { readonly status: 'done'; readonly result: unknown }
  | {
      readonly status: 'unknown';
      readonly before: string;
      readonly after: string | null;
      readonly observed: string;
    };

export interface ShellReconcileInput {
  readonly classification: ShellClassification;
  /** The journalled scaffold, or `null` when none was ever written. */
  readonly scaffold: MutatingShellScaffold | null;
  /** `git status --porcelain` hashed right now, in the effect's worktree. */
  readonly observed: string;
}

/** The sha256 of the exact bytes `git status --porcelain` printed. */
export function porcelainHash(porcelain: string): Promise<string> {
  return contentHash(porcelain);
}

export function reconcileShell(input: ShellReconcileInput): ShellReconcileVerdict {
  // AC4. A `pure` command claims that running it again has no consequence, so
  // the hashes are not consulted at all — not even when a stale scaffold from
  // an earlier classification happens to be lying next to it.
  if (input.classification === 'pure') return { status: 'not-started' };

  const { scaffold, observed } = input;

  // No scaffold means the daemon died between the intent row and the first
  // line of `perform()`. The scaffold is committed before the command is
  // spawned, exactly as the intent row is committed before the effect, so
  // "no scaffold" is the same write-ahead argument the journal itself rests
  // on rather than an optimistic reading of a missing row.
  if (scaffold === null) return { status: 'not-started' };

  if (observed === scaffold.before) return { status: 'not-started' };
  if (scaffold.after !== null && observed === scaffold.after) {
    return { status: 'done', result: scaffold.result };
  }

  return { status: 'unknown', before: scaffold.before, after: scaffold.after, observed };
}
