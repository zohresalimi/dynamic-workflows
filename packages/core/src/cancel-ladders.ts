/**
 * KAR-27.9 — which cancel ladders a run supports, answered from its route.
 *
 * ## The question this story had to answer before writing a line
 *
 * *"Can a cooperative stop even be delivered to the process this daemon
 * spawns?"* The two routes answer differently, and the answer is a property of
 * the transport rather than of the vendor:
 *
 * - **`acp`** — the child speaks ACP JSON-RPC over its stdio, and the client
 *   holds the connection for the whole turn. `session/cancel` is a notification
 *   on that connection, the agent flushes its remaining `session/update`s and
 *   answers the prompt with `stopReason: 'cancelled'`
 *   (docs/07-provider-adapter-layer.md §2.5). There is a channel, and rung 1 is
 *   real: `packages/adapters/src/run-node.ts` sends it the moment
 *   `AcpPorts.signal` aborts.
 * - **`shim`** — the child is the vendor's own CLI run headless for one turn
 *   (`claude -p …`). Its stdout is a one-way `stream-json` dialect and there is
 *   **no request channel back**: nothing DeFlow can write to that process
 *   means *stop politely*. The only thing it can send is a signal, which is
 *   the forceful ladder by another name.
 *
 * So cooperative cancel is not universally available, and the honest surface is
 * a refusal at the point of request rather than a rung that silently does
 * nothing (AC2). Before this module, asking for one on the shim route was
 * accepted, appended, and parked for ever — which is the wait KAR-27.6 made
 * legible and this makes impossible.
 *
 * ## The second fact, and why the refusal is not route alone
 *
 * A run with nothing running has no agent to ask, whatever route it was
 * admitted onto: both ladders reduce to the same `run.aborted` on the next
 * tick, because the drive finds no live process either way. AC2 refuses a
 * cooperative cancel *"accepted into a wait that cannot end"*, and that is not
 * a wait — so refusing there would make the run `deflow cancel` was built to
 * dispose of (EPIC-19-S39, EPIC-19-S40) need `--force` for nothing.
 *
 * ## Why it is in `@DeFlow/core`
 *
 * Same argument as `./provider-choice.ts` one field over: three surfaces have
 * to agree — `POST /api/runs/:id/cancel`'s refusal, `GET /api/runs/:id`'s
 * capability, and whatever the CLI and the UI disable. AC3 asks for *one* fact,
 * so it is one pure function over those two inputs, living where every surface
 * can reach it. The refusal's *way out* is not spelled here either: it comes
 * from `forcefulCancelCommand`, the one producer of that command
 * (`test/one-cancel-remedy.test.ts`).
 *
 * Verifies: EPIC-27-S42, EPIC-27-S43 · KAR-27.9 AC2, AC3
 */
import { forcefulCancelCommand } from './cooperative-cancel.ts';
import type { CancelMode } from './event-payloads.ts';
import { CANCEL_MODES } from './event-payloads.ts';
import type { ProviderRoute } from './provider-choice.ts';
import { routeLabel } from './provider-choice.ts';

/**
 * The routes whose transport can carry `session/cancel`.
 *
 * A list rather than `route === 'acp'` at four call sites, because the day a
 * third route arrives the question *"can it carry a cooperative stop"* has to
 * be asked of it once, here, rather than answered by omission everywhere.
 */
export const PROTOCOL_CANCEL_ROUTES: readonly ProviderRoute[] = ['acp'];

/** What a run's route says about how it can be stopped. */
export interface CancelLadders {
  /** The route the run was admitted onto, or `null` for a run that never
   * reached one — nothing was spawned, so there is nothing to ask. */
  readonly route: ProviderRoute | null;
  /** The modes `POST /api/runs/:id/cancel` will accept for this run, in
   * `CANCEL_MODES` order. Never empty: forceful is always available. */
  readonly modes: readonly CancelMode[];
  /** Whether rung 1 — asking the agent over the protocol — can be delivered. */
  readonly cooperative: boolean;
}

/** The two things a run's ladders are a function of, and nothing else. */
export interface CancelLaddersInput {
  /** The route the run was admitted onto, from its `provider.probed` record. */
  readonly route: ProviderRoute | null;
  /**
   * Whether the run has an agent turn in flight — a node the ledger says is
   * `running`.
   *
   * The second fact, and it is what keeps AC2's refusal from swallowing
   * EPIC-19-S39. AC2 is about a cooperative cancel *"accepted into a wait that
   * cannot end"*, and a run with nothing running is not a wait at all: both
   * ladders reduce to the same `run.aborted` on the next tick, because
   * `finishCancels` finds no live process. Refusing there would make a run that
   * never started — the exact thing `deflow cancel` was built to dispose of —
   * need `--force`, for no gain whatsoever.
   */
  readonly inFlight: boolean;
}

/**
 * AC3 — the one fact, from the run's route and whether anything is running.
 *
 * One function rather than a rule at the refusal and a second rule at the
 * capability: `POST /api/runs/:id/cancel` refuses exactly the modes this leaves
 * out, and `GET /api/runs/:id` serves exactly what this answers, so a control
 * that offers a ladder the daemon then refuses is a compile-time impossibility
 * rather than a code review.
 *
 * A `null` route answers *both* ladders for the same reason `inFlight: false`
 * does: no route was recorded because nothing was ever spawned.
 */
export function cancelLaddersFor(input: CancelLaddersInput): CancelLadders {
  const { route, inFlight } = input;
  const cooperative = !inFlight || route === null || PROTOCOL_CANCEL_ROUTES.includes(route);
  return {
    route,
    cooperative,
    modes: CANCEL_MODES.filter((mode) => mode !== 'cooperative' || cooperative),
  };
}

/** True when this run may be cancelled with `mode`. */
export function cancelModeAvailable(input: CancelLaddersInput, mode: CancelMode): boolean {
  return cancelLaddersFor(input).modes.includes(mode);
}

/**
 * AC2 — the refusal, naming forceful as the ladder that is available.
 *
 * It says *why* as well as *what*: "this route has no channel" is a fact about
 * the machinery the operator can act on — reinstall the ACP adapter and the
 * gentle ladder comes back — while a bare "unavailable" reads as a bug in
 * DeFlow. And it names the cost of the ladder it recommends, because the whole
 * reason the operator chose the other one is the transcript.
 */
export function cooperativeCancelUnavailable(runId: string, route: ProviderRoute): string {
  return (
    `run ${runId} is running on the ${routeLabel(route)} route, which has no channel to carry a ` +
    'cooperative stop: the vendor CLI is spawned for one turn and the only thing DeFlow can send ' +
    `it is a signal. End it with '${forcefulCancelCommand(runId)}', which stops it for certain ` +
    'and may truncate the transcript of the turn in flight.'
  );
}
