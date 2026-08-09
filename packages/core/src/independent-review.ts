/**
 * KAR-12.2 — the two scheduling preconditions that make a green review
 * evidence rather than a self-assessment
 * ([docs/10-verification-gates.md §3.2](../../../docs/10-verification-gates.md)).
 *
 * §3 draws the line this file keeps: **"a different session" is a hard
 * scheduling precondition; "preferably a different provider" is a routing
 * decision.** The routing half lives in `@DeFlow/adapters` (`pick-reviewer.ts`),
 * because it reads probed capability rows. This half is pure, and it is pure on
 * purpose — it is asked at the last point before a reviewer receives any input,
 * on two adapter paths whose only common ground is a resolved session id and a
 * node.
 *
 * **Two codes, because they are two different mistakes.**
 * `REVIEW_SESSION_NOT_INDEPENDENT` is plumbing: something resolved the review
 * onto the producer's session, and a reviewer sitting in the producer's session
 * has the producer's whole conversation in its window.
 * `REVIEW_INHERITS_PRODUCER_CONTEXT` is a decision: somebody forked, which is a
 * natural-looking way to give the reviewer "context" and inherits the
 * producer's reasoning wholesale. An operator reading a refused run needs to
 * know which of the two happened, because the fixes are not related.
 *
 * **Forking stays legal everywhere else.** `claude-agent-acp` and `opencode acp`
 * both advertise `session.fork` (**verified 2026-08-02**), and continuation work
 * is exactly what it is for. So the refusal is scoped to review nodes, and the
 * scoping is the caller's — nothing here bans a resume shape globally.
 *
 * **Fail closed.** A review whose session id has not resolved yet cannot be
 * shown to be independent, and "we could not tell" must never render as "it
 * was". The empty case refuses rather than passing.
 *
 * A `NodeFailureError` subclass rather than a bare `Error`, so a refusal
 * reaches `node.failed` through the one boundary every other adapter failure
 * uses (KAR-05.1 AC7) instead of needing a second path of its own.
 *
 * **`class: 'gate'` rather than `'permanent'`**, and the difference is the
 * whole of EPIC-12-S12's second scenario. A permanent failure fails the node
 * and propagates `dependency.failed`; a `gate` class suspends the run for a
 * human (./retry.ts), which is the correct answer to *the plan asks for a
 * review that cannot be independent*. Retrying is the one thing that must not
 * happen: a retry re-derives the same schedule and reaches the same answer, so
 * a transient class would spend an afternoon re-proving a structural
 * impossibility at 1 Hz.
 *
 * **The reason is `gate.failed` and the code lives in `detail`**, deliberately.
 * `NodeFailureReason` is embedded in `DeFlow.plangraph.v1` and
 * `DeFlow.planpatch.v1` through `retry.onFailure.when`, and both are shipped
 * documents whose bytes are content-pinned (`schemas/CHANGELOG.md`) — so one
 * new member of that union is two new document versions and a cascade of
 * payload bumps across EPIC-11's surface, bought for a distinction the
 * `detail.code` already carries losslessly. The gate produced no `pass` and the
 * refusal code says why, which is what a reader and a UI both need.
 *
 * Verifies: EPIC-12-S12, EPIC-12-S13 · AC1, AC2, AC3, AC4
 */
import type { NodeId } from './ids.ts';
import { NodeFailureError } from './node-failure.ts';

/** §3.2's two codes, in the order the section defines them. */
export const REVIEW_REFUSAL_CODES = [
  'REVIEW_SESSION_NOT_INDEPENDENT',
  'REVIEW_INHERITS_PRODUCER_CONTEXT',
] as const;

export type ReviewRefusalCode = (typeof REVIEW_REFUSAL_CODES)[number];

/**
 * A resume, in either spelling DeFlow has for one.
 *
 * The plan graph spells `AgentNode.resume` as a policy — `native-if-available`
 * or `always-replay` (./plan-graph.ts) — and an adapter-level resume request is
 * a shape naming a session or a node. Both are accepted here because both are
 * things that reach a scheduler, and a check that only understood the tidy one
 * would admit the untidy one silently.
 */
export type ResumeRequest =
  | 'native-if-available'
  | 'always-replay'
  | {
      /** `fork` is the shape §3.2 refuses. Anything else is a policy name. */
      readonly kind?: string;
      /** The node whose session this resumes. */
      readonly of?: string;
    };

/** What the precondition needs to know about the review node. */
export interface ReviewNodeView {
  readonly id: NodeId;
  /**
   * The session the reviewer will actually speak on — the uuid DeFlow minted
   * on the CLI shim path, or the one `session/new` returned on the ACP path.
   * Never a plan-time intention: AC1 is checkable from `node.started` payloads,
   * and those carry what resolved.
   */
  readonly resolvedSessionId: string;
  readonly resume?: ResumeRequest;
}

/** What it needs to know about each node named in `independence.notSessionOf`. */
export interface ProducerNodeView {
  readonly id: NodeId;
  /** `null` for a producer that held no session at all — a `tool` node, say.
   * There is nothing to collide with, and refusing on it would make an
   * ordinary plan unschedulable. */
  readonly resolvedSessionId: string | null;
}

/**
 * The refusal. `gate`-classed by construction — see the header.
 *
 * `producer` is on the error rather than only in the message because the
 * scheduler files it into `node.failed.detail`, and a detail a UI has to
 * regex out of prose is not a detail.
 */
export class SchedulingRefused extends NodeFailureError {
  readonly code: ReviewRefusalCode;
  readonly node: NodeId;
  readonly producer: NodeId;

  constructor(code: ReviewRefusalCode, node: NodeId, producer: NodeId, message: string) {
    super(message, {
      reason: 'gate.failed',
      class: 'gate',
      detail: { code, node, producer },
    });
    this.name = 'SchedulingRefused';
    this.code = code;
    this.node = node;
    this.producer = producer;
  }

  /** The scheduler's only question about a failure (./node-failure.ts).
   * `gate` means *suspend for a human*: there is no automatic action that
   * makes an impossible schedule possible. */
  get failureClass(): 'gate' {
    return 'gate';
  }
}

/** Whether a caught value is one of §3.2's refusals. */
export function isReviewRefusal(thrown: unknown): thrown is SchedulingRefused {
  return thrown instanceof SchedulingRefused;
}

/** Whether the resume shape hands the producer's own thread to the reviewer. */
function inheritsFrom(resume: ResumeRequest | undefined, producer: NodeId): boolean {
  if (resume === undefined || typeof resume === 'string') return false;
  return resume.kind === 'fork' || resume.of === producer;
}

/**
 * Refuses the schedule, or returns void.
 *
 * Called at the last point before the reviewer receives any input, which is a
 * different point on each adapter path and is stated on both: on the **CLI shim
 * path** DeFlow mints the uuid and passes `--session-id <uuid>`, so the check
 * runs *before spawn*; on the **ACP path** the id is only known once
 * `session/new` returns, so it runs *after `session/new` and before
 * `session/prompt`*. In neither case does the reviewer see a prompt first.
 *
 * Both checks run against every producer named in `independence.notSessionOf`,
 * because a review of three nodes' work must be independent of all three.
 */
export function assertIndependentReview(
  review: ReviewNodeView,
  producers: readonly ProducerNodeView[],
): void {
  if (review.resolvedSessionId === '') {
    const named = producers[0]?.id ?? review.id;
    throw new SchedulingRefused(
      'REVIEW_SESSION_NOT_INDEPENDENT',
      review.id,
      named,
      `review node ${review.id} has no resolved session id, so its independence from ${named} ` +
        'cannot be shown. The check runs at the last point before the reviewer receives input ' +
        'and fails closed: an unanswerable question is not a pass',
    );
  }

  for (const producer of producers) {
    if (producer.resolvedSessionId === review.resolvedSessionId) {
      throw new SchedulingRefused(
        'REVIEW_SESSION_NOT_INDEPENDENT',
        review.id,
        producer.id,
        `review node ${review.id} resolved to session ${review.resolvedSessionId}, which is the ` +
          `session producer node ${producer.id} ran on. A reviewer inside the producer's session ` +
          "is reading the producer's own conversation, which voids F7.2",
      );
    }
  }

  for (const producer of producers) {
    if (inheritsFrom(review.resume, producer.id)) {
      throw new SchedulingRefused(
        'REVIEW_INHERITS_PRODUCER_CONTEXT',
        review.id,
        producer.id,
        `review node ${review.id} asks to resume ${JSON.stringify(review.resume)}, which inherits ` +
          `producer node ${producer.id}'s reasoning wholesale. Forking is legitimate for ` +
          'continuation work and forbidden for review — it is never the single-provider fallback',
      );
    }
  }
}
