/**
 * KAR-16.3 test plan #11 / EPIC-16-S11 (third scenario) — the compile-time half
 * of "unknown kinds are ignored".
 *
 * Verifies: EPIC-16-S11 · AC11
 *
 * This file asserts nothing at runtime and is never executed. It is compiled by
 * `pnpm typecheck`, and that is the whole point: `@DeFlow/web` imports the
 * `Event` union **type-only** from `@DeFlow/core`, so a kind added on the
 * backend has to surface in the UI *in the same commit that added it* — and a
 * `default: return` in seven switches is exactly what would swallow it.
 *
 * `./kinds.ts` is the mechanism, and this is the proof that it has teeth. Every
 * `@ts-expect-error` below is load-bearing in both directions: if the construct
 * it guards ever *does* compile, TypeScript reports the unused directive as an
 * error of its own. So the fixture fails either way round, which is the only
 * kind of negative type test worth having.
 */
import type { Event, EventKind } from '@DeFlow/core';
import {
  EVENT_KIND_OWNERS,
  type Ignorable,
  type KindsOwnedBy,
  type ProjectionName,
} from './kinds.ts';

// ── the ownership table is total over EventKind ──────────────────────────────

/** Every kind is present. A kind added to `@DeFlow/core` fails right here. */
export const owners: Record<EventKind, readonly ProjectionName[]> = EVENT_KIND_OWNERS;

export function incomplete(): Record<EventKind, readonly ProjectionName[]> {
  // @ts-expect-error — a table missing one kind is not a `Record<EventKind, …>`.
  // This is the failure a newly added event kind produces in `./kinds.ts`, and
  // the reason it produces it *there* rather than silently nowhere.
  return { 'node.started': ['plan'] };
}

export const surplus: Record<EventKind, readonly ProjectionName[]> = {
  ...EVENT_KIND_OWNERS,
  // @ts-expect-error — and a table naming a kind this build does not have is
  // refused too, so a kind *removed* from the backend cannot linger here.
  'node.telemetry.sampled': [],
};

// ── each projection's switch is exhaustive over the kinds it claims ──────────

/**
 * A switch that handles every kind `plan` claims. The `default` branch's
 * parameter is `Ignorable<'plan'>`, which is every event *except* those — so
 * this compiles only because nothing claimed is left over.
 */
export function completeSwitch(event: Event): string {
  switch (event.kind) {
    case 'plan.proposed':
    case 'plan.patch.proposed':
    case 'plan.patched':
    case 'node.scheduled':
    case 'node.started':
    case 'node.progress':
    case 'node.completed':
    case 'node.failed':
    case 'node.retry.scheduled':
    case 'node.suspended':
    case 'node.blocked':
    case 'node.unschedulable':
    case 'node.cancelled':
      return 'handled';
    default:
      return accepts<'plan'>(event);
  }
}

/**
 * The same switch with `node.blocked` forgotten — which is precisely what
 * happens when a kind is added to the union and one projection is not updated.
 * The `default` branch still receives it, and it is not `Ignorable<'plan'>`.
 */
export function incompleteSwitch(event: Event): string {
  switch (event.kind) {
    case 'plan.proposed':
    case 'plan.patch.proposed':
    case 'plan.patched':
    case 'node.scheduled':
    case 'node.started':
    case 'node.progress':
    case 'node.completed':
    case 'node.failed':
    case 'node.retry.scheduled':
    case 'node.suspended':
    case 'node.unschedulable':
    case 'node.cancelled':
      return 'handled';
    default:
      // @ts-expect-error — `node.blocked` is claimed by `plan` and unhandled,
      // so it is still in the narrowed union here and this call does not
      // typecheck. That is the build failing in the same commit.
      return accepts<'plan'>(event);
  }
}

function accepts<Name extends ProjectionName>(event: Ignorable<Name>): string {
  return String(event.kind);
}

// ── the derived slice is the table's own, not a restatement ──────────────────

/** `plan` claims `node.blocked`; the type says so without anyone repeating it. */
export const claimed: KindsOwnedBy<'plan'> = 'node.blocked';

// @ts-expect-error — and it does not claim `fact.written`, which is
// `blackboard`'s. A projection reaching for another's kinds is a design
// question, and it is asked at compile time.
export const notClaimed: KindsOwnedBy<'plan'> = 'fact.written';
