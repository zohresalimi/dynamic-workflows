/**
 * KAR-19.10 AC4 — reading a run's provider choice back out of the ledger.
 *
 * The sibling of `./run-refusal.ts`, and shaped like it for the same reasons: a
 * refusal is why a run never started, this is what a run that *did* start is
 * running on, and neither is `RunState`. Both are facts about the machine on
 * the day the run was submitted, so both are re-read from the `provider.probed`
 * rows admission wrote rather than folded into a projection (NF8).
 *
 * One thing is deliberately different. The refusal's *prose* is not stored and
 * is re-rendered here; the choice's three facts **are** stored, because they are
 * not prose — they are what was decided, and re-deriving them from this
 * machine's `PATH` on a later request is exactly the second reduction that
 * produced the 2026-08-13 disagreement. The *sentence* is still rendered rather
 * than stored, by `announceProviderChoice`, which is the one function all three
 * surfaces compose it with (`test/one-provider-announcement.test.ts`).
 *
 * Verifies: EPIC-19-S67 · AC4
 */
import type { ProviderChoiceFacts, ProviderRoute, RouteState, RunId } from '@DeFlow/core';
import { announceProviderChoice, isProviderRoute } from '@DeFlow/core';
import type { LedgerView } from './ledger-view.ts';

/** The same bound `runRefusal` reads under: a submission's rows sit at the head
 * of a run's ledger, and there are at most one per registered provider. */
const ADMISSION_WINDOW = 64;

/** What `GET /api/runs/:id` carries for a run admission admitted. */
export interface RunProvider extends ProviderChoiceFacts {
  /** Both routes as this machine answered them when the run was submitted. */
  readonly routes: { readonly acp: RouteState; readonly shim: RouteState };
  /** The turns this route cannot serve. Empty is the ordinary case. */
  readonly unserved: readonly string[];
  /** AC7's sentence, if the operator was given one. */
  readonly limitation?: string;
  /** The one line, from the one renderer — so a client never composes its own. */
  readonly announcement: string;
}

const routeState = (value: unknown): RouteState =>
  value === 'available' ? 'available' : 'missing';

/**
 * The `chosen` block off an admission `provider.probed` payload, or `null`.
 *
 * Read structurally rather than through the Zod union, exactly as
 * `run-refusal.ts` reads its own arm: what arrives here has been through
 * `JSON.parse`, and the honest thing to say about it is what was checked.
 */
function asChoice(provider: unknown, payload: unknown): RunProvider | null {
  const chosen = (payload as { chosen?: unknown } | null)?.chosen as
    | Record<string, unknown>
    | undefined;
  if (chosen === undefined || typeof provider !== 'string') return null;
  if (typeof chosen.binaryPath !== 'string' || !isProviderRoute(chosen.route)) return null;

  const routes = (chosen.routes ?? {}) as Record<string, unknown>;
  const facts: ProviderChoiceFacts = {
    provider,
    binaryPath: chosen.binaryPath,
    route: chosen.route satisfies ProviderRoute,
  };

  return {
    ...facts,
    routes: { acp: routeState(routes.acp), shim: routeState(routes.shim) },
    unserved: Array.isArray(chosen.unserved)
      ? chosen.unserved.filter((turn): turn is string => typeof turn === 'string')
      : [],
    ...(typeof chosen.limitation === 'string' ? { limitation: chosen.limitation } : {}),
    announcement: announceProviderChoice(facts),
  };
}

/**
 * Which provider this run was admitted onto, and by which route — or `null` for
 * a run that was refused, or one submitted by a daemon that was never told
 * which machine it is on.
 */
export function runProvider(view: LedgerView, runId: RunId): RunProvider | null {
  for (const event of view.tail(runId, 0, ADMISSION_WINDOW)) {
    if (event.kind !== 'provider.probed') continue;
    const choice = asChoice((event.payload as { provider?: unknown }).provider, event.payload);
    if (choice !== null) return choice;
  }
  return null;
}
