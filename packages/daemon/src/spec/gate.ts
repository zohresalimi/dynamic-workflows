/**
 * KAR-10.3 — the F1.3 approval gate, as durable machinery
 * (docs/06-planning-and-replanning.md §1.3).
 *
 * *"This is implemented as a blocking `human` node, suspended durably — a row in
 * `node_wake`, zero CPU, survives laptop sleep and daemon restart. A six-hour
 * think about a spec costs one SQLite row."* That sentence is the whole design,
 * and four properties of this file are what make it true rather than intended:
 *
 * **Nothing here holds anything.** No promise is parked, no timer is set, no
 * connection is kept. Opening the gate writes two things — a `human.requested`
 * event and one `node_wake` row — and returns. The operator's answer arrives
 * minutes or days later through an entirely separate call, on a daemon that may
 * be a different process.
 *
 * **The event and the row are one transaction, in both directions.** Opening
 * writes the event and the row together; answering appends the response and
 * deletes the row together (`appendEventsConsumingWakes`). Split either pair and
 * a crash in between leaves a gate nobody can answer or a wait nothing will
 * fire — and the second is the one nobody notices, because the run simply never
 * comes back.
 *
 * **Approval and the pin are one commit.** `run.spec.approved` and `spec.pinned`
 * carry adjacent `seq` values from the same `appendEvents` call, so there is no
 * crash point between them by construction (EPIC-10-S19). A run that came back
 * approved but unpinned would build every later packet from a spec nothing had
 * digested, and `assertPinIntegrity` would have nothing to check against.
 *
 * **The gate is not a fast path.** The temptation the epic names explicitly is
 * to skip the human node and flip a status. It is refused here: the suspension
 * mechanics are the same ones every later gate uses, and this is the cheapest
 * possible place to prove they work.
 *
 * The scheduling half of F1.3 is not in this file at all, and that is
 * deliberate: `decide()` in @DeFlow/core admits nothing while
 * `state.specApproved` is `null`, so *"no node other than framing and recon is
 * ever scheduled before approval"* is a property of the pure scheduler rather
 * than a check on the way in here (KAR-10.3 AC3).
 *
 * Verifies: EPIC-10-S13, EPIC-10-S14, EPIC-10-S15, EPIC-10-S16, EPIC-10-S18,
 * EPIC-10-S29 · AC1-AC5, AC7, AC8, AC9
 */
import type {
  Constraint,
  Db,
  Event,
  RunId,
  SpecAmendment,
  SpecCoverageIssue,
  TaskSpec,
  TaskSpecDraft,
} from '@DeFlow/core';
import {
  buildSpecPinnedSegments,
  currentSpec,
  EventSeqSchema,
  initialRunState,
  NO_DEADLINE_WAKE_AT,
  NodeIdSchema,
  parseEvent,
  renderSpecForReview,
  revalidateSpecAgainstPlan,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
} from '@DeFlow/core';
import type { EventDraft } from '@DeFlow/ledger';
import {
  appendEvents,
  appendEventsConsumingWakes,
  headSeq,
  readRange,
  replayAll,
  scheduleWake,
} from '@DeFlow/ledger';
import { amendSpec } from './amend.ts';

/**
 * How many framing attempts the operator may reject before the run stops asking
 * (EPIC-10-S15's third scenario).
 *
 * Three, and the vocabulary is deliberately §11.3's `churn`: three framing
 * attempts with no accepted spec is the same shape as three replans with no
 * completed nodes — *"a plan built on a false premise, and the only thing that
 * can supply the missing premise is the person who wrote the spec"*.
 * Auto-scheduling a fourth attempt is the failure that scenario forbids.
 */
export const SPEC_REJECTION_LIMIT = 3;

/** How the operator reached the gate. `run.spec.approved.by`'s vocabulary. */
export type SpecDecidedBy = 'ui' | 'cli';

export interface GateOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly epoch: number;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
}

export interface OpenGateOptions extends GateOptions {
  /** The framed document the operator reviews — `DeFlow.taskspecdraft.v1`. */
  readonly document: TaskSpecDraft;
}

/**
 * AC1 — opens the gate: a blocking `human` node carrying the rendered spec and
 * the four options, plus the one row that is the wait.
 *
 * Called after the framing node completes and after `run.created`, which is why
 * it takes the framed document rather than reading one: the sealed spec is in
 * the ledger, but the document the operator edits is the *draft*, and until an
 * amendment exists the ledger has no copy of it.
 */
export function openSpecApprovalGate(options: OpenGateOptions): void {
  const { db, runId, epoch, ts } = options;
  db.transaction(() => {
    appendEvents(db, [
      {
        runId,
        ts,
        kind: 'human.requested',
        v: 1,
        epoch,
        nodeId: SPEC_GATE_NODE,
        payload: {
          node: SPEC_GATE_NODE,
          prompt: renderSpecForReview(options.document),
          options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
        },
      },
    ]);
    scheduleWake(db, {
      runId,
      nodeId: SPEC_GATE_NODE,
      wakeAt: NO_DEADLINE_WAKE_AT,
      reason: 'human_gate',
    });
  });
}

/** The gate was answered when it was not open, or answered twice. */
export class SpecGateNotOpen extends Error {
  constructor(runId: string, decision: string) {
    super(
      `cannot ${decision} the spec of ${runId}: no approval gate is open. F1.3's gate is a ` +
        'blocking human node, so an answer is only meaningful while one is waiting — a second ' +
        'approval would append a second run.spec.approved and mint a second pinned set for a ' +
        'decision nobody made twice.',
    );
    this.name = 'SpecGateNotOpen';
  }
}

const EVENT_PAGE = 10_000;

/**
 * Every event of the run, parsed and upcast.
 *
 * `readRange` hands back `StoredEvent`s — envelopes as the row holds them —
 * and everything in @DeFlow/core takes `Event`s that have been through
 * `parseEvent`, which is where the version is upcast and the payload validated.
 * A row this build cannot parse is **skipped rather than guessed at**, exactly
 * as the reducer skips a kind it has never heard of: an older daemon reading a
 * newer ledger degrades, and a newer one reading a corrupted row does not
 * approve against a payload it could not read.
 */
function ledger(db: Db, runId: RunId): readonly Event[] {
  return readRange(db, runId, 0, EVENT_PAGE).events.flatMap((stored) => {
    const parsed = parseEvent(stored);
    return parsed.status === 'ok' ? [parsed.event] : [];
  });
}

/**
 * Whether a `human.requested` on the gate node is still unanswered.
 *
 * Derived from the log rather than from a flag, for the reason F4.4 gives about
 * pause: a boolean does not survive the restart it exists to protect against,
 * and a six-hour think is exactly the wait a restart happens inside of.
 */
function gateIsOpen(events: readonly Event[]): boolean {
  let open = false;
  for (const event of events) {
    if (event.kind === 'human.requested' && event.payload.node === SPEC_GATE_NODE) open = true;
    if (event.kind === 'human.responded' && event.payload.node === SPEC_GATE_NODE) open = false;
  }
  return open;
}

/** The operator's answer, as the ledger records it. */
function responded(options: GateOptions, optionId: string, text?: string): EventDraft {
  return {
    runId: options.runId,
    ts: options.ts,
    kind: 'human.responded',
    v: 1,
    epoch: options.epoch,
    nodeId: SPEC_GATE_NODE,
    payload: {
      node: SPEC_GATE_NODE,
      optionId,
      ...(text === undefined ? {} : { text }),
      at: new Date(options.ts).toISOString(),
    },
  };
}

/**
 * The approval and the pinned set it mints, as two drafts destined for one
 * commit (AC4).
 *
 * `sourceEvent` is the ledger's current head rather than the seq the approval
 * will get, and it does not matter which: `pinnedSegment` hashes the segment's
 * **text** and nothing else, so the digests this records are a function of the
 * spec alone. What the field records is which event put the bytes there, and the
 * head is the honest answer at the moment they are computed.
 */
async function approvalDrafts(
  options: GateOptions & { readonly by: SpecDecidedBy },
  spec: TaskSpec,
  constraints: readonly Constraint[],
): Promise<readonly EventDraft[]> {
  const segments = await buildSpecPinnedSegments({
    spec,
    constraints,
    sourceEvent: EventSeqSchema.parse(Math.max(1, headSeq(options.db))),
  });

  return [
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'run.spec.approved',
      v: 1,
      epoch: options.epoch,
      payload: { specHash: spec.specHash, by: options.by },
    },
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'spec.pinned',
      v: 1,
      epoch: options.epoch,
      payload: {
        specHash: spec.specHash,
        segments: segments.map((segment) => ({
          id: segment.id,
          kind: segment.kind,
          sha256: segment.contentHash,
        })),
      },
    },
  ];
}

export interface ApproveOptions extends GateOptions {
  readonly by: SpecDecidedBy;
  /** The run's safety constraints (F5.6). Defaults to none declared. */
  readonly constraints?: readonly Constraint[];
}

export interface Approval {
  readonly specHash: string;
}

/**
 * AC4 — approve: `human.responded`, `run.spec.approved` and `spec.pinned` in one
 * transaction, with the wake consumed by the same commit.
 *
 * The order is the order they are read in: the answer, then what the answer
 * decided, then what that minted. The last two are adjacent by construction,
 * which is EPIC-10-S19's *"no crash point exists between them"*.
 */
export async function approveSpec(options: ApproveOptions): Promise<Approval> {
  const events = ledger(options.db, options.runId);
  if (!gateIsOpen(events)) throw new SpecGateNotOpen(options.runId, 'approve');

  const spec = await currentSpec(events);
  if (spec === null) throw new SpecGateNotOpen(options.runId, 'approve');

  const drafts = await approvalDrafts(options, spec, options.constraints ?? []);
  appendEventsConsumingWakes(
    options.db,
    [responded(options, 'approve'), ...drafts],
    [{ runId: options.runId, nodeId: SPEC_GATE_NODE }],
  );
  return { specHash: spec.specHash };
}

export interface EditOptions extends GateOptions {
  readonly by: SpecDecidedBy;
  /** A complete replacement framed document, as the operator edited it. */
  readonly edited: unknown;
  readonly constraints?: readonly Constraint[];
}

export interface SpecEdit extends SpecAmendment {
  /**
   * What revalidating the amended spec against the run's current plan found
   * (AC8). Always `[]` for an edit at the gate, where there is no plan yet.
   */
  readonly revalidation: readonly SpecCoverageIssue[];
}

/**
 * AC5 and AC8 — edit, at the gate or mid-run. **The same operation**, which is
 * §1.3's point: *"editing the spec mid-run is a first-class operation, not a
 * hack."*
 *
 * What differs is what the ledger already says, not what the operator did:
 *
 * - **At the gate** (nothing approved yet) the edit appends `spec.amended` and
 *   leaves the gate open. An edit is not an approval — EPIC-10-S14 has the
 *   operator edit *and then* approve, and a gate that closed itself on an edit
 *   would approve a document nobody re-read.
 * - **Mid-run** there is no gate to leave open, so the edit carries its own
 *   approval: `spec.amended`, `run.spec.approved` at the new hash and a new
 *   `spec.pinned`, in one transaction. Without the re-approval the run would
 *   execute against `B` while every gate resolved `A`, and
 *   `gateSpecFromLedger` would refuse every verdict rather than judge it.
 *   Revalidation then runs against the plan the run is actually executing, and
 *   a failure appends `run.needs_human` — *"rather than continuing against a
 *   spec it no longer satisfies"*. Running nodes are not cancelled: a spec edit
 *   is not a kill switch (F5.7 is), and killing in-flight work on every edit
 *   would make editing feel dangerous, which is the opposite of what F1.3 needs.
 *
 * Throws `SpecEditRefused` — from `amendSpec`, with the framing interview's own
 * message text — for an edit that breaks the criteria contract or changes
 * nothing. The gate stays open and the run is not failed (EPIC-10-S14's third
 * scenario).
 */
export async function editSpec(options: EditOptions): Promise<SpecEdit> {
  const events = ledger(options.db, options.runId);
  const previous = await currentSpec(events);
  if (previous === null) throw new SpecGateNotOpen(options.runId, 'edit');

  const atGate = gateIsOpen(events);
  const amendment = await amendSpec(previous, options.edited);

  const amended: EventDraft = {
    runId: options.runId,
    ts: options.ts,
    kind: 'spec.amended',
    v: 1,
    epoch: options.epoch,
    payload: {
      from: amendment.from,
      to: amendment.to,
      patch: amendment.patch,
      document: amendment.document,
      by: options.by,
    },
  };

  if (atGate) {
    // The answer, the amendment, and the gate re-opened on the *edited*
    // document — one transaction, because an edit that closed the gate without
    // re-opening it would leave a run nobody can approve, and a re-render that
    // committed separately could show the operator a spec the ledger does not
    // have. The `node_wake` row stays exactly where it is: the same gate is
    // still waiting for the same operator, and consuming it only to write it
    // back would be a commit that changed nothing.
    appendEvents(options.db, [
      responded(options, 'edit'),
      amended,
      {
        runId: options.runId,
        ts: options.ts,
        kind: 'human.requested',
        v: 1,
        epoch: options.epoch,
        nodeId: SPEC_GATE_NODE,
        payload: {
          node: SPEC_GATE_NODE,
          prompt: renderSpecForReview(amendment.document),
          options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
        },
      },
    ]);
    return { ...amendment, revalidation: [] };
  }

  const drafts = await approvalDrafts(
    { ...options, by: options.by },
    amendment.spec,
    options.constraints ?? [],
  );
  appendEvents(options.db, [amended, ...drafts]);

  const state = replayAll(options.db).runs.get(options.runId) ?? initialRunState();
  const revalidation =
    state.plan === null ? [] : revalidateSpecAgainstPlan(amendment.spec, state.plan);
  if (revalidation.length > 0) {
    appendEvents(options.db, [
      {
        runId: options.runId,
        ts: options.ts,
        kind: 'run.needs_human',
        v: 2,
        epoch: options.epoch,
        payload: {
          reason: 'spec-revalidation',
          detail: revalidation.map((issue) => issue.message).join(' '),
        },
      },
    ]);
  }
  return { ...amendment, revalidation };
}

export interface RejectOptions extends GateOptions {
  readonly by: SpecDecidedBy;
  readonly reason: string;
  /** The provider the next framing attempt is scheduled on. */
  readonly provider: string;
}

export interface Rejection {
  /** How many framing attempts have now been rejected. */
  readonly attempt: number;
  /** The spec the operator refused — still in the ledger, still at its hash. */
  readonly rejected: TaskSpec;
  readonly reason: string;
  /** The inputs the next framing attempt's packet carries, or `null` when the
   * churn breaker stopped rather than trying again. */
  readonly reframe: { readonly spec: TaskSpec; readonly reason: string } | null;
}

/** Every rejection the gate has recorded, oldest first. */
function rejections(events: readonly Event[]): readonly string[] {
  return events
    .filter(
      (event) =>
        event.kind === 'human.responded' &&
        event.payload.node === SPEC_GATE_NODE &&
        event.payload.optionId === 'reject',
    )
    .map((event) => (event.kind === 'human.responded' ? (event.payload.text ?? '') : ''));
}

/**
 * AC7 — reject: the reason is recorded, the rejected spec stays addressable, and
 * a second framing attempt is scheduled with both as inputs.
 *
 * **Rejection is not abandonment.** The rejected spec is still `run.created.spec`
 * at its own hash, and `buildFramingPacket` takes it and the reason as the
 * second attempt's inputs (KAR-10.2 AC9) — so the next attempt is told what was
 * wrong rather than starting from the same blank page that produced it.
 *
 * The third rejection stops instead: `run.needs_human { reason: 'churn' }` and
 * **no fourth attempt**, which is EPIC-10-S15's third scenario stated as code.
 */
export async function rejectSpec(options: RejectOptions): Promise<Rejection> {
  const events = ledger(options.db, options.runId);
  if (!gateIsOpen(events)) throw new SpecGateNotOpen(options.runId, 'reject');

  const rejected = await currentSpec(events);
  if (rejected === null) throw new SpecGateNotOpen(options.runId, 'reject');

  const attempt = rejections(events).length + 1;
  const churned = attempt >= SPEC_REJECTION_LIMIT;

  const drafts: EventDraft[] = [responded(options, 'reject', options.reason)];
  if (churned) {
    drafts.push({
      runId: options.runId,
      ts: options.ts,
      kind: 'run.needs_human',
      v: 2,
      epoch: options.epoch,
      payload: {
        reason: 'churn',
        detail:
          `${attempt} framing attempts have been rejected and none produced a spec you would ` +
          'approve. No further attempt is scheduled: the missing premise is one only you can ' +
          'supply.',
      },
    });
  } else {
    drafts.push({
      runId: options.runId,
      ts: options.ts,
      kind: 'node.scheduled',
      v: 1,
      epoch: options.epoch,
      nodeId: FRAMING_NODE,
      payload: { node: FRAMING_NODE, provider: options.provider, permission: 'read' },
    });
  }

  appendEventsConsumingWakes(options.db, drafts, [
    { runId: options.runId, nodeId: SPEC_GATE_NODE },
  ]);

  return {
    attempt,
    rejected,
    reason: options.reason,
    reframe: churned ? null : { spec: rejected, reason: options.reason },
  };
}

/**
 * The node the framing interview runs as, and the one node AC3 permits a
 * `node.scheduled` for before the spec is approved (with the recon nodes
 * KAR-10.5 adds).
 */
export const FRAMING_NODE = NodeIdSchema.parse('framing');

export interface AbandonOptions extends GateOptions {
  readonly by: SpecDecidedBy;
}

/**
 * AC9 — abandon: `run.aborted`, and every artifact produced so far still
 * inspectable on disk (NF8).
 *
 * `outcome: 'failed'` because `RUN_OUTCOMES` is a closed set of three and
 * `partial` means *some* acceptance criteria were satisfied, which is a claim a
 * run abandoned before it started cannot make. Nothing is deleted, moved or
 * compacted: the run ends by appending a row, like everything else here.
 */
export function abandonRun(options: AbandonOptions): void {
  const events = ledger(options.db, options.runId);
  if (!gateIsOpen(events)) throw new SpecGateNotOpen(options.runId, 'abandon');

  appendEventsConsumingWakes(
    options.db,
    [
      responded(options, 'abandon'),
      {
        runId: options.runId,
        ts: options.ts,
        kind: 'run.aborted',
        v: 1,
        epoch: options.epoch,
        payload: { outcome: 'failed', criteriaSatisfied: [] },
      },
    ],
    [{ runId: options.runId, nodeId: SPEC_GATE_NODE }],
  );
}
