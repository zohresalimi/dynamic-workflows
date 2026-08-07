/**
 * KAR-09.4 — re-inject the pinned set on a turn interval, not only on
 * compaction (docs/08-context-and-memory.md §4.2(a)).
 *
 * Pinning (KAR-09.3) fixes the compaction half of the decay problem and does
 * nothing at all about the other half. arXiv 2604.20911 measured it: omission
 * compliance — following a *don't* — falls from **73% at turn 5 to 33% at turn
 * 16**, while commission compliance holds at 100%. Nothing was deleted; the
 * constraint is still in the window and is simply no longer acted on. The
 * default interval of **8** comes from that curve — an interval anywhere near
 * 16 is already too late.
 *
 * **This module decides *when*, never *whether*.** Delivery is an appended
 * `session/prompt` turn, which only an adapter advertising mid-session steering
 * can accept; where it cannot, the honest answer is the AC6 warning below and
 * not a counter that ticks into a no-op. Keeping the two apart is what lets the
 * arithmetic be tested without a subprocess and the delivery be tested without
 * arithmetic.
 *
 * The counter is a reducer rather than a mutable turn number because of AC7:
 * the compaction path re-injects for its own reason, and *any* verbatim
 * re-injection resets the interval. A compaction at turn 7 followed by an
 * interval tick at turn 8 would otherwise send the same bytes twice in
 * consecutive turns — which teaches the model that the pinned block is noise.
 *
 * Verifies: EPIC-09-S23, EPIC-09-S24 · AC5, AC6, AC7
 */

/** §4.2(a)'s Safe Turn Depth, and `.DeFlow/config.yaml`'s default. */
export const PIN_REINJECT_TURNS_DEFAULT = 8;

export interface ReinjectCounter {
  /** `pinReinjectTurns` for the provider this node runs on. */
  readonly everyTurns: number;
  /** Turns since the pinned set was last delivered verbatim. */
  readonly turnsSinceReinjection: number;
}

export function startReinjection(everyTurns: number = PIN_REINJECT_TURNS_DEFAULT): ReinjectCounter {
  return { everyTurns, turnsSinceReinjection: 0 };
}

export interface TurnTick {
  readonly counter: ReinjectCounter;
  /** True on the turn the interval came due. The counter returned is already
   * reset, because the caller only asks when it can actually deliver. */
  readonly reinject: boolean;
}

/** One completed turn. On the ACP path that is one `session/prompt`. */
export function afterTurn(counter: ReinjectCounter): TurnTick {
  const turnsSinceReinjection = counter.turnsSinceReinjection + 1;
  if (turnsSinceReinjection < counter.everyTurns) {
    return { counter: { ...counter, turnsSinceReinjection }, reinject: false };
  }
  return { counter: afterReinjection(counter), reinject: true };
}

/**
 * AC7 — the pinned set went out verbatim for some *other* reason, most often a
 * compaction. The interval restarts from here.
 */
export function afterReinjection(counter: ReinjectCounter): ReinjectCounter {
  return { ...counter, turnsSinceReinjection: 0 };
}

export interface ReinjectionPlanningInput {
  readonly node: string;
  /**
   * What the plan expects this node to cost in turns. Absent means the planner
   * declared none, and a warning about a number nobody supplied would be noise
   * — the exec-shim path, where there is no observable turn boundary at all, is
   * exactly that case.
   */
  readonly expectedTurns?: number;
  readonly pinReinjectTurns: number;
  /**
   * What the adapter's probed manifest says about mid-session steering.
   * `undefined` is "never advertised" and is treated exactly like a refusal
   * (EPIC-09-S24's outline) — the decision is driven by the capability, never
   * by a provider name.
   */
  readonly steering: boolean | undefined;
}

/**
 * AC6 — the planning smell, named.
 *
 * §4.2(a): *"a node that runs 30 turns without a re-injection point is a
 * planning smell, and the packet builder should warn."* The remedy is to split
 * the node, which is why the text says so: an operator who cannot steer the
 * adapter can still keep nodes short, and that is the whole of the mitigation
 * available on that path.
 */
export function reinjectionPlanningWarning(input: ReinjectionPlanningInput): string | null {
  if (input.steering === true) return null;
  if (input.expectedTurns === undefined) return null;
  if (input.expectedTurns <= input.pinReinjectTurns) return null;
  return (
    `node "${input.node}" is expected to run ${input.expectedTurns} turns but the target adapter ` +
    'does not advertise mid-session steering, so no pinned re-injection turn can be appended. ' +
    `Prohibitions decay with turn depth (docs/08-context-and-memory.md §4.2), and past ` +
    `pinReinjectTurns=${input.pinReinjectTurns} there is no re-injection point: split the node.`
  );
}
