/**
 * KAR-19.10 AC4 — `provider.ts`: which agent this run is on, and by which route.
 *
 * The eighth projection, and the smallest. It folds one event kind and holds
 * one object, because the question it answers is asked once per run: admission
 * chose a provider before the first turn and wrote the choice down, and every
 * surface that shows a run has to be able to say what it was.
 *
 * ## Why it is a projection and not a query
 *
 * docs/12-frontend-architecture.md §3.4's rule: *"if the answer changes because
 * an event was appended, it is a projection"*. It does — `provider.probed` is
 * the event, and a run whose route changes between phases writes another one
 * (AC5), which this folds by replacing what it holds. A cached `GET
 * /api/runs/:id` would go stale for exactly as long as its stale window, which
 * is the interval an operator spends looking at the name of an agent the run is
 * no longer using.
 *
 * ## Why the sentence is not built here
 *
 * `announceProviderChoice` in `@DeFlow/core` composes it, and this holds only
 * the facts. Three surfaces render that sentence — a terminal, an HTTP body and
 * this tab — and a second composition written for the browser is exactly the
 * drift AC4 exists to stop (`test/one-provider-route-reducer.test.ts`).
 *
 * Verifies: EPIC-19-S67 · AC4
 */
import type { Event, ProviderRoute, RouteState } from '@DeFlow/core';
import { isProviderRoute } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

export interface ProviderChoiceState {
  readonly provider: string;
  /** Absolute — the path the child is spawned from, never a name. */
  readonly binaryPath: string;
  readonly route: ProviderRoute;
  readonly routes: { readonly acp: RouteState; readonly shim: RouteState };
  /** AC7's sentence, when this machine cannot serve every turn. */
  readonly limitation: string | null;
}

export interface ProviderProjection {
  /** `null` until admission has written a choice — a refused run never does. */
  chosen: ProviderChoiceState | null;
  /** The highest `seq` folded. The cursor moves for **every** event, including
   * kinds this build cannot read: a frame that was seen has been seen, and a
   * client that forgot would re-request it on every reconnect for the life of
   * the run (EPIC-16-S11). */
  appliedSeq: number;
}

export const emptyProvider = (): ProviderProjection => ({ chosen: null, appliedSeq: 0 });

const routeState = (value: unknown): RouteState =>
  value === 'available' ? 'available' : 'missing';

/**
 * Folds the admitted arm of `provider.probed`, and only that arm.
 *
 * A refusal writes the same kind, one row per provider, carrying no `chosen`
 * block — because a refusal chose nothing. Reading `chosen` as the
 * discriminator is what keeps those rows out of here without this file needing
 * to know anything about refusals.
 */
export function applyProvider(state: ProviderProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'provider.probed': {
      const payload = event.payload as { provider?: unknown; chosen?: unknown };
      const chosen = payload.chosen as Record<string, unknown> | undefined;
      if (chosen === undefined || typeof payload.provider !== 'string') return;
      if (typeof chosen.binaryPath !== 'string' || !isProviderRoute(chosen.route)) return;

      const routes = (chosen.routes ?? {}) as Record<string, unknown>;
      state.chosen = {
        provider: payload.provider,
        binaryPath: chosen.binaryPath,
        route: chosen.route,
        routes: { acp: routeState(routes.acp), shim: routeState(routes.shim) },
        limitation: typeof chosen.limitation === 'string' ? chosen.limitation : null,
      };
      return;
    }
    default:
      ignored<'provider'>(event as Ignorable<'provider'>);
  }
}
