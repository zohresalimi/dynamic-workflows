/**
 * KAR-06.4 — the `shell` effect: the kind with no clever fix
 * (docs/05-durable-execution.md §8.3, EPIC-06-S12, EPIC-06-S15).
 *
 * A shell command is not idempotent in general. DeFlow does not pretend
 * otherwise; it splits the problem at **plan time** into the two cases that
 * have honest answers:
 *
 * - **`pure`** — test, lint, build, typecheck. Re-run it after a crash. The
 *   cost is time.
 * - **`mutating`** — migrations, publishes, network POSTs. Run it in a
 *   dedicated worktree with a hash of `git status --porcelain` journalled
 *   before and after, and reconcile by re-hashing.
 *
 * The two scaffold writes are the whole mechanism, and their placement is the
 * whole story:
 *
 * ```
 * scaffold{ before }  →  run the command  →  scaffold{ before, after, result }  →  markDone
 * ```
 *
 * The first is committed *before anything is spawned*, so a missing scaffold
 * proves the command never started — the same write-ahead argument the intent
 * row itself rests on. The second is the last act of `perform()`, with no
 * `await` between it and the runner's `markDone`, which is as small as the
 * window of EPIC-06-S16 can be made. Crash inside *that* window and the
 * after-hash still matches, so the probe answers `done` instead of `unknown`
 * — which is the difference between a run that resumes and a run that wakes a
 * human at 3 a.m.
 *
 * What is *not* journalled anywhere is the command's own idea of whether it
 * succeeded. Exit code 0 from a half-applied migration is a lie the ledger
 * must not repeat.
 *
 * Verifies: EPIC-06-S12 (shell rows), EPIC-06-S15, EPIC-06-S16 · AC4, AC5
 */
import type { NodeId, RunId } from '@DeFlow/core';
import type { Effect, EffectCtx, ReconcileProbe } from './durable.ts';
import {
  type MutatingShellScaffold,
  porcelainHash,
  reconcileShell,
  type ShellClassification,
} from './reconcile/shell.ts';

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ShellEffectPorts {
  /** Runs the command. Exit codes are data: a non-zero exit is a result, and
   * what it means is the caller's business, not this module's. */
  run(): Promise<ShellResult>;
  /**
   * `git status --porcelain` in the worktree the command runs in.
   *
   * Consulted only for `mutating`. A `pure` command never pays for two extra
   * git invocations per effect, which matters when the pure ones are the test
   * and lint nodes that run on every attempt.
   */
  porcelain(): Promise<string>;
}

export interface ShellEffectInput {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly ordinal?: number;
  readonly requestHash: string;
  /** Assigned when the plan was written. Never inferred from the command. */
  readonly classification: ShellClassification;
}

const SCAFFOLD_KIND = 'shell.mutating';

/** The journalled scaffold, or `null` when the row carries none. Anything
 * unparseable is `null` too: a scaffold nobody can read is a scaffold that is
 * not there, and guessing at its halves would be worse than re-running. */
function readScaffold(resultJson: string | null): MutatingShellScaffold | null {
  if (resultJson === null) return null;
  try {
    const parsed = JSON.parse(resultJson) as Partial<MutatingShellScaffold>;
    if (parsed.kind !== SCAFFOLD_KIND || typeof parsed.before !== 'string') return null;
    return {
      kind: SCAFFOLD_KIND,
      before: parsed.before,
      after: typeof parsed.after === 'string' ? parsed.after : null,
      result: parsed.result ?? null,
    };
  } catch {
    return null;
  }
}

export function shellEffect(input: ShellEffectInput, ports: ShellEffectPorts): Effect<ShellResult> {
  const mutating = input.classification === 'mutating';
  const observe = async (): Promise<string> => porcelainHash(await ports.porcelain());

  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    kind: 'shell',
    requestHash: input.requestHash,

    async perform(ctx: EffectCtx): Promise<ShellResult> {
      if (!mutating) return ports.run();

      const before = await observe();
      // Durable before the spawn. This is the line that makes "no scaffold
      // means it never ran" a fact rather than an assumption.
      ctx.scaffold({ kind: SCAFFOLD_KIND, before, after: null, result: null });

      const result = await ports.run();

      // The last act before returning, so the runner's markDone follows with
      // no intervening await. The window is shrunk here, not closed — it
      // cannot be closed, and EPIC-06-S16 says so out loud.
      ctx.scaffold({ kind: SCAFFOLD_KIND, before, after: await observe(), result });
      return result;
    },

    async reconcile(ctx: EffectCtx): Promise<ReconcileProbe<ShellResult>> {
      if (!mutating) return { status: 'not-started' };

      const scaffold = readScaffold(ctx.row.resultJson);
      const observed = await observe();
      const verdict = reconcileShell({
        classification: input.classification,
        scaffold,
        observed,
      });

      if (verdict.status === 'not-started') return { status: 'not-started' };
      if (verdict.status === 'done') {
        return { status: 'done', result: verdict.result as ShellResult };
      }

      return {
        status: 'unknown',
        detail:
          'the worktree matches neither the hash journalled before the command nor the one ' +
          'journalled after it',
        evidence: { before: verdict.before, after: verdict.after, observed: verdict.observed },
      };
    },
  };
}
