/**
 * KAR-28.7 — the one place `packages/web` decides what status a run is in, and
 * the one place it turns that into a sentence.
 *
 * Verifies: EPIC-28-S26, EPIC-28-S27, EPIC-28-S28, EPIC-28-S29, EPIC-28-S30 ·
 * AC1–AC6
 *
 * ## What went wrong
 *
 * On 2026-08-26 the frame's status pill read **needs a decision** for
 * `run_20260826T060745Z_d81b6c` while the run was planning. The daemon was
 * right throughout — `GET /api/runs` and `GET /api/runs/:id` both answered
 * `spec-approved`, with `pendingGate` `null` because the spec gate's own
 * `human.responded` had populated `gate.response`.
 *
 * The web was wrong because it kept a sticky per-kind table of its own that
 * covered eight event kinds. `human.requested` latched the status to
 * `needs-human`, and neither `human.responded` nor `run.spec.approved` owned an
 * entry — so nothing could take it off again until one of `run.started`,
 * `run.paused`, `run.resumed`, `run.cancel.requested`, `run.completed` or
 * `run.aborted` arrived, and a run appends none of those between spec approval
 * and the planner adopting a plan. The events were delivered and folded
 * correctly into every projection; they simply owned no status.
 *
 * ## The decision this module records (AC2)
 *
 * AC2 offers two shapes and asks for the reason to be written down. **A client
 * table, made total, is the one taken**, and the alternative — folding every
 * frame through `@DeFlow/core`'s `reduce()` in the browser and reading
 * `RunState.status` — is deleted rather than left half-present. Three reasons,
 * in the order they decided it:
 *
 * 1. **`reduce()` does not say `needs-human` for a gate.** Its `human.requested`
 *    arm suspends the *node* and moves the run only for the F1.3 spec gate,
 *    to `awaiting-spec-approval`. A run that stops on any other gate stays
 *    `running` in the reducer's eyes. That is the right answer for a scheduler
 *    and the wrong one for a person scanning a list for the run that is waiting
 *    on them, which is what these two surfaces are for.
 * 2. **`reduce()` is total over unknown *kinds*, not over unknown *payloads*.**
 *    `withHumanGate` reads `payload.options.map`, so one frame that never went
 *    through `parseEvent` throws. The daemon folds inside a transaction that
 *    can fail loudly; a tab cannot, and `../ledger/apply.ts` already catches
 *    per projection for exactly this reason.
 * 3. **It would fold twice.** A tab following a run already folds every frame
 *    into ten projections, and one of them (`liveTurn`) is the pre-execution
 *    record this module needs. A second whole-`RunState` fold beside it would
 *    be the same events reduced twice on the same thread.
 *
 * So the table below is a **view** fold, and it is honest about being one. What
 * it is not allowed to be is *partial*: `test/one-run-status-source.test.ts`
 * reads `reduce.ts` and fails, naming the kind, the day a status-changing arm
 * is added without an answer here.
 *
 * ## And the label is still the daemon's (AC4)
 *
 * Nothing here spells a status word. `runStatusView` hands the folded status to
 * `runStatusLabel` from `@DeFlow/core` — the same function `deflow status`,
 * `deflow run` and `GET /api/runs` print through — together with whatever
 * pre-execution turns the tab has folded, so KAR-27.3's composed sentence
 * (*"planner — running · attempt 1 of 3 · since <instant>"*) reaches the frame
 * instead of the bare word `planning`. `packages/web` introduces no second
 * label vocabulary, and `test/one-status-label.test.ts` is what keeps that true.
 */
import type { Event, PreExecutionTurns, RunState, RunStatus } from '@DeFlow/core';
import { initialRunState, runStatusLabel } from '@DeFlow/core';

/** A run's status and the sentence beside it, from one derivation. */
export interface RunStatusView {
  readonly status: RunStatus;
  readonly label: string;
}

/**
 * What the surfaces carry between frames.
 *
 * `beforeGate` is the whole of the fix. A run that stops to ask is still doing
 * whatever it was doing — the gate is a wait laid over a status, not a status —
 * so the status underneath is kept, and the answer puts it back. Without it
 * there is no honest way off `needs-human`, which is how the latch came to be
 * one-way in the first place.
 */
export interface RunStatusFold {
  readonly status: RunStatus;
  readonly beforeGate: RunStatus | null;
}

/**
 * Every event kind that says what status a run is in.
 *
 * Total over the ten arms of `reduce()` that change `RunState.status`, plus
 * nothing: a kind that leaves the status alone in the reducer must leave it
 * alone here, or this table becomes a second opinion rather than a rendering of
 * the first.
 *
 * `human.requested` is the one entry that is a view decision rather than a
 * transcription — see reason 1 in the header — and `run.needs_human` is the
 * reducer's own spelling of the same state.
 */
export const RUN_STATUS_BY_KIND: Readonly<Record<string, RunStatus>> = {
  'run.created': 'created',
  'run.spec.approved': 'spec-approved',
  'run.started': 'running',
  'run.paused': 'paused',
  'run.resumed': 'running',
  'run.cancel.requested': 'cancelling',
  'run.needs_human': 'needs-human',
  'run.completed': 'completed',
  'run.aborted': 'aborted',
  'human.requested': 'needs-human',
};

/** The kind that ends a wait without changing a status. */
const GATE_ANSWERED = 'human.responded';

/**
 * The status a run that has just answered a gate goes back to, when nothing
 * recorded what it was doing before it asked.
 *
 * A row hydrated from `GET /api/runs` while its gate was already open is the
 * case: the daemon's word arrived, the `human.requested` that produced it did
 * not, and there is no earlier status to restore. `running` is the reducer's
 * own answer to a gate being answered — its `human.responded` arm puts the
 * suspended node back to `running`, and `run.resumed` clears `needsHuman` to
 * `running` — rather than a word invented here.
 */
const AFTER_AN_ANSWER: RunStatus = 'running';

/**
 * One frame folded into the surfaces' status, or `previous` when the frame says
 * nothing about it.
 *
 * `null` in and `null` out is "this surface has heard nothing about this run
 * yet", which is what keeps the pill absent rather than blank on a tab that has
 * opened a run and not yet received a frame.
 */
export function foldRunStatus(previous: RunStatusFold | null, event: Event): RunStatusFold | null {
  if (event.kind === GATE_ANSWERED) {
    if (previous === null) return null;
    if (previous.beforeGate !== null) {
      return { status: previous.beforeGate, beforeGate: null };
    }
    return previous.status === 'needs-human'
      ? { status: AFTER_AN_ANSWER, beforeGate: null }
      : previous;
  }

  const status = RUN_STATUS_BY_KIND[event.kind];
  if (status === undefined) return previous;
  if (status !== 'needs-human') return { status, beforeGate: null };

  // Asked twice before an answer: the first ask is the one that knows what the
  // run was doing, so it is the one kept.
  const beforeGate =
    previous === null || previous.status === 'needs-human'
      ? (previous?.beforeGate ?? null)
      : previous.status;
  return { status, beforeGate };
}

/** A fold seeded from a status the daemon already answered with. */
export function runStatusFoldOf(status: RunStatus): RunStatusFold {
  return { status, beforeGate: null };
}

/**
 * The status and the sentence, from a whole `RunState`.
 *
 * This is the branch a *scrubbed* tab takes: the server folded the position and
 * the surface renders what it was handed, which is AC2's "taken as given" for
 * every case where a real `RunState` is available.
 */
export function runStatusView(state: RunState): RunStatusView {
  return { status: state.status, label: runStatusLabel(state) };
}

/**
 * The same answer for a surface that has a status and the run's pre-execution
 * turns rather than a whole `RunState`.
 *
 * The initial state is filled in around them rather than a second label
 * function being written: `runStatusLabel` reads `status`, `preExecution`, the
 * cancel record and the stall watermark, and a surface that has none of the
 * last two has nothing to say about them. That is exactly what
 * `initialRunState()` already says, so the composed pre-execution sentence
 * arrives and no other clause is invented.
 */
export function runStatusViewOf(status: RunStatus, turns: PreExecutionTurns = {}): RunStatusView {
  return runStatusView({ ...initialRunState(), status, preExecution: turns });
}
