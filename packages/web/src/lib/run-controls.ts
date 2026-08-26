/**
 * KAR-27.7 — which control the run surface offers, in which state, and what
 * each one is allowed to do.
 *
 * Verifies: EPIC-27-S34, EPIC-27-S37 · AC1, AC3, AC4
 *
 * The endpoints have existed since KAR-15.5 and no frame surface called any of
 * them (KAR-26.5's audit), so every stop performed on 2026-08-25 was performed
 * with `curl`. This module is the decision half of the fix: the *component* is
 * `../components/RunControls.vue` and the *request* is `../api/run-control.ts`;
 * what is here is pure and testable without a DOM.
 *
 * ## The one rule worth stating: the daemon decides, this file asks
 *
 * AC3's word is **exactly** — "a control is disabled, with a reason, exactly
 * when the daemon would refuse it". So `enabled` is not a table of statuses
 * maintained beside `planRunControl`; it *is* `planRunControl`, called with the
 * status the ledger reduced to. KAR-27.7 moved that function out of
 * `@DeFlow/daemon` and into `@DeFlow/core` for this call and no other reason.
 * The `reason` shown is the plan's own sentence, so a refusal an operator reads
 * before pressing is word-for-word the refusal they would have read after.
 *
 * The situation passed carries the status and nothing else. `establishedSeq` is
 * only ever echoed back on a no-op, and `cancel` — the ladder already in flight
 * — is not projected in the tab, so a stop offered against a run that is
 * already cancelling forcefully is *enabled* and re-sends the same request. The
 * endpoint is idempotent over the state machine (§11.1), so the cost of that is
 * one extra append of a request the run is already serving, and the alternative
 * would be a control that greys out while a kill ladder runs.
 *
 * ## Why `stop` and not `cancel`
 *
 * The verb on the wire is `cancel`; the word on the button is Stop. They are
 * separated here rather than conflated because the button is *one* of the two
 * ladders `cancel` offers, and calling it Cancel would suggest it were the
 * whole verb. `RUN_CONTROL_STOP_MODE` states which ladder, always — see its own
 * note for which one, and why the button states it rather than defaulting.
 */
import type { CancelMode, RunControlVerb, RunStatus } from '@DeFlow/core';
import { planRunControl, RUN_CONTROL_ENDED } from '@DeFlow/core';

/** What an operator can press. Three actions over the three endpoints. */
export type RunControlAction = 'pause' | 'resume' | 'stop';

/** The endpoint each action reaches. Stop is `cancel`; see the header comment. */
export const RUN_CONTROL_VERB: Readonly<Record<RunControlAction, RunControlVerb>> = Object.freeze({
  pause: 'pause',
  resume: 'resume',
  stop: 'cancel',
});

/**
 * The ladder the Stop button takes, stated and never defaulted (AC1).
 *
 * Forceful, and still forceful now that KAR-27.9 has built the cooperative
 * rung. The reason has changed rather than gone away. It used to be that the
 * endpoint's default asked nobody anything, so a Stop that took it appeared to
 * do nothing. Now the default *is* delivered — on a route that can carry it —
 * and it ends when the agent chooses to answer, which is not what a button
 * labelled Stop promises. The cooperative ladder stays where an operator can
 * choose it deliberately, having read that it is the one that keeps the
 * transcript; a button does not make that choice for them.
 */
export const RUN_CONTROL_STOP_MODE: CancelMode = 'forceful';

export interface RunControlOffer {
  readonly action: RunControlAction;
  /** The word on the button. */
  readonly label: string;
  /** The accessible name — a sentence, because "Stop" alone names no object. */
  readonly name: string;
  readonly enabled: boolean;
  /** The daemon's own refusal, verbatim, or `null` while the control works. */
  readonly reason: string | null;
}

/** The button face and the accessible name for each action, in one place. */
const WORDS: Readonly<Record<RunControlAction, { label: string; name: string }>> = Object.freeze({
  pause: { label: 'Pause', name: 'Pause this run' },
  resume: { label: 'Resume', name: 'Resume this run' },
  stop: { label: 'Stop', name: 'Stop this run' },
});

/**
 * What the confirmation says (AC4).
 *
 * Stop asks and pause does not, and the asymmetry is the whole of AC4: pause is
 * reversible by the button beside it, and a dialog in front of a reversible
 * action is a dialog people learn to dismiss without reading. What this one has
 * to say is the cost the operator cannot see — the turn in flight is signalled
 * rather than asked, so whatever the agent had not yet written down is gone.
 */
export const STOP_CONFIRMATION = Object.freeze({
  title: 'Stop this run?',
  warning:
    'Stop signals the agent rather than asking it, so the transcript of the turn in flight may be truncated.',
  irreversible: 'A stopped run cannot be resumed — only a new run continues the work.',
  confirmLabel: 'Stop the run',
  cancelLabel: 'Keep running',
});

/**
 * The other ladder, for an operator who would rather have the transcript.
 *
 * No flag: the cooperative ladder is the endpoint's *default*, and this button
 * is the forceful one. Naming a flag here would be naming this button's own
 * ladder as the alternative to itself.
 */
export const cooperativeStopHint = (runId: string): string =>
  `To let the agent finish its turn and flush the transcript instead, run ` +
  `deflow cancel ${runId} from a terminal.`;

/** The daemon's answer for one action against one status. */
function offer(status: RunStatus, action: RunControlAction): RunControlOffer {
  const plan = planRunControl(
    {
      verb: RUN_CONTROL_VERB[action],
      by: 'user',
      ...(action === 'stop' ? { mode: RUN_CONTROL_STOP_MODE } : {}),
    },
    { status, establishedSeq: 0 },
  );

  return {
    action,
    ...WORDS[action],
    enabled: plan.outcome !== 'refused',
    reason: plan.outcome === 'refused' ? plan.message : null,
  };
}

/**
 * AC1 — the controls this run's state has an answer for.
 *
 * A concluded run gets none: there is nothing to pause and nothing to stop, and
 * a row of dimmed buttons under a finished run is chrome pretending to be an
 * offer (EPIC-27-S34). Every other state gets exactly one of pause/resume — the
 * two are the same control in two positions — and a stop.
 */
export function runControlOffers(status: RunStatus | null): readonly RunControlOffer[] {
  if (status === null || RUN_CONTROL_ENDED.includes(status)) return [];
  const holdOrContinue: RunControlAction = status === 'paused' ? 'resume' : 'pause';
  return [offer(status, holdOrContinue), offer(status, 'stop')];
}
