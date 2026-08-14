/**
 * KAR-19.3 — when a run is still owed a framing turn, derived from the ledger.
 *
 * A tiny module of its own so that `../drive.ts` can ask the question without
 * importing the chain that answers it — the driver dispatches, the chain
 * performs, and the two are deliberately not the same file (see drive.ts's own
 * note on owning no policy).
 *
 * **The question is not "has this run been framed".** It was, before this
 * story: `readRunCreatedSpec(db, runId) !== null` was the whole test, which is
 * correct for exactly one framing turn per run and wrong for both of the ways a
 * run legitimately gets a second one:
 *
 *   - the operator **rejected** the spec, and `rejectSpec` appended a
 *     `node.scheduled` for the framing node saying so (KAR-10.3 AC7). Before
 *     this story nothing consumed that, so a rejection was a dead end wearing
 *     the clothes of a retry;
 *   - framing **asked a clarifying question**, and the answer arrived through
 *     `POST /runs/:id/nodes/:nodeId/respond`, which consumes the wake row in the
 *     same transaction as `human.responded` — leaving a run that is waiting for
 *     nothing at all.
 *
 * So the rule is a comparison of sequence numbers rather than a presence check:
 * a run is owed a framing turn when the most recent thing that *asked* for one
 * is newer than the most recent `run.created`. That is a pure function of the
 * log, which is what makes it survive the restart in EPIC-19-S22 and the
 * six-hour suspension in EPIC-19-S18 without a flag anywhere.
 *
 * Verifies: EPIC-19-S18, EPIC-19-S19 · KAR-19.3 AC4
 */
import type { Db, Event, RunId } from '@DeFlow/core';
import { parseEvent } from '@DeFlow/core';
import { lastSeqOfKinds, readRange } from '@DeFlow/ledger';
import { FRAMING_NODE } from '../spec/gate.ts';

/** A pre-plan run's whole log fits far inside this; `readRange` is a seek on
 * `(run_id, seq)` and the page bound is what keeps it one. */
const EVENT_PAGE = 5_000;

/** The run's events, skipping any this build cannot read — a degraded
 * projection rather than a wrong one, exactly as `spec/gate.ts` reads them. */
function ledger(db: Db, runId: RunId): readonly Event[] {
  return readRange(db, runId, 0, EVENT_PAGE).events.flatMap((stored) => {
    const parsed = parseEvent(stored);
    return parsed.status === 'ok' ? [parsed.event] : [];
  });
}

/**
 * The seq of the newest event that asks for a framing turn, or 0.
 *
 * Three shapes, and they are the three ways a framing turn is ever asked for:
 * the submission itself, a rejection's re-schedule, and the operator's answer
 * to a clarifying question.
 */
function lastFramingRequest(events: readonly Event[]): number {
  let at = 0;
  for (const event of events) {
    if (event.kind === 'task.submitted') at = Math.max(at, event.seq);
    if (event.kind === 'node.scheduled' && event.payload.node === FRAMING_NODE) {
      at = Math.max(at, event.seq);
    }
    if (event.kind === 'human.responded' && event.payload.node === FRAMING_NODE) {
      at = Math.max(at, event.seq);
    }
  }
  return at;
}

const lastRunCreated = (events: readonly Event[]): number =>
  events.reduce((at, event) => (event.kind === 'run.created' ? Math.max(at, event.seq) : at), 0);

/**
 * Whether this run is still owed a framing turn.
 *
 * Reads the run's log, so callers that run once a second per run in the data
 * directory should put `framingCouldBePending` in front of it.
 */
export function framingIsPending(db: Db, runId: RunId): boolean {
  const events = ledger(db, runId);
  return lastFramingRequest(events) > lastRunCreated(events);
}

/**
 * A covering-index pre-filter for the question above, for the same reason the
 * stall detector has one: the loop that asks runs *"do you need anything"* runs
 * once a second for every run the directory has ever held, and folding each of
 * them is a cost that grows with the operator's history rather than with their
 * work.
 *
 * Deliberately a superset — it cannot tell a framing `node.scheduled` from any
 * other node's — and never the decision.
 */
export function framingCouldBePending(db: Db, runId: RunId): boolean {
  const created = lastSeqOfKinds(db, runId, ['run.created']);
  if (created === null) return true;
  const asked = lastSeqOfKinds(db, runId, ['node.scheduled', 'human.responded']);
  return asked !== null && asked > created;
}
