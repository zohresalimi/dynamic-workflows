/**
 * KAR-10.2 — the framing interview: the one place a `TaskSpec` is born
 * (docs/06-planning-and-replanning.md §1.2).
 *
 * Everything downstream is judged against what this node produces, so the file
 * is written as a sequence of refusals with a success at the end rather than
 * the other way round.
 *
 * **Admission first, before a session exists.** `admitFraming` reads the probed
 * `provider_capabilities` row and the resolved adapter's invocation spec, and a
 * provider with no way to take a schema is refused with
 * `adapter.capability-missing`. There is no prose fallback anywhere on this
 * path — no regex, no JSON-block extraction, no heuristic parse — because *"a
 * regex over prose is how the planner layer starts breaking on every CLI
 * update"*, and the spec is what every gate verdict is measured against.
 *
 * **The contract is EPIC-09's, not a second copy of it.** `enforceHandoff`
 * measures the return against `framingReturns()` — `DeFlow.taskspecdraft.v1` at
 * 4000 tokens (AC10) — repairs exactly once, and fails with
 * `contract.schema-invalid`. Nothing here shortens, defaults or partially
 * accepts a document: `sealTaskSpec` is the one door a `TaskSpec` comes through
 * and it throws rather than emit a half-written one.
 *
 * **`run.created` is appended last, and only on success (AC11).** Its payload
 * *is* the `TaskSpec`, so a framing node that failed validation has nothing to
 * put in one — which is why a failed interview leaves no half-born run, exactly
 * as KAR-10.1's intake does. `repo.head` and `repo.branch` are read from the
 * real repository at that moment through the `readRepo` port rather than
 * carried down from intake, because minutes of interview can pass between the
 * two and a stale head is a run created against a commit it never saw.
 *
 * **A clarifying question is a row, not a held promise.** The interview appends
 * `human.requested` and writes one `node_wake` with `reason = 'human_gate'` in
 * the same transaction; the answer consumes that row in the same transaction as
 * `human.responded`. Split either pair and a crash in between loses one half —
 * and the half nobody notices is the one where the run simply never comes back.
 *
 * **Steering versus replay is reported as what it was.** An adapter that
 * advertises mid-session steering gets the answer as a further turn on the live
 * session; one that does not gets a fresh session with the question and the
 * answer replayed into its packet. The two are different events and
 * docs/11-api-and-realtime.md §7.5 is explicit that the UI *"must render that
 * honestly rather than showing a delivered guidance bubble that never
 * arrived"*, so the delivery is returned and a `node.progress` row says which.
 *
 * Verifies: EPIC-10-S6, EPIC-10-S7, EPIC-10-S10, EPIC-10-S11 · AC1-AC3,
 * AC7, AC8, AC10, AC11
 */
import type { CapabilityRow } from '@DeFlow/adapters';
import { admitFraming } from '@DeFlow/adapters';
import type {
  ClarifyingExchange,
  ContextPacket,
  Db,
  Handle,
  NodeId,
  RunId,
  StructuredOutput,
  TaskSpec,
  Tokenizer,
} from '@DeFlow/core';
import {
  EventSeqSchema,
  framingReturns,
  NodeFailureError,
  renderPacket,
  sealTaskSpec,
  toNodeFailure,
  withClarifyingAnswers,
} from '@DeFlow/core';
import { appendEvents, appendEventsConsumingWakes, headSeq, scheduleWake } from '@DeFlow/ledger';
import type { Git } from '../git/git.ts';
import { enforceHandoff, type HandoffSession, type HandoffValidator } from '../handoff/enforce.ts';

/**
 * A question the framing agent could not answer from the repository.
 *
 * `deadline` is required and is an *instant*: it becomes `node_wake.wake_at`,
 * which is what makes the wait survive laptop sleep and a daemon restart. A
 * question with no deadline would be a row nothing ever polls, which is a wait
 * with no way back.
 */
export interface FramingQuestion {
  readonly prompt: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly effect: 'approve' | 'reject' | 'edit' | 'inject';
  }[];
  /** ISO-8601. */
  readonly deadline: string;
}

/** What one turn of the interview produced. */
export interface FramingTurn {
  /** A clarifying question, or `null` when the agent answered with a document. */
  readonly question: FramingQuestion | null;
  /**
   * The result envelope's `structured_output`, as a tagged presence rather than
   * `?? {}` — an absent field is a contract failure, not an empty object.
   */
  readonly structuredOutput: StructuredOutput;
  /** AC7 of KAR-09.9: the vendor already spent its own bounded repair loop. */
  readonly vendorRepairExhausted?: boolean;
}

/** The live session the interview is being conducted in. */
export interface FramingSession extends HandoffSession {
  /**
   * Whether this adapter advertises mid-session steering, read from its probed
   * row (`supportsSteering`) rather than from its name.
   */
  readonly steerable: boolean;
  /** Sends one further turn into this session. */
  answer(text: string): Promise<FramingTurn>;
}

/** Opens a fresh ACP session at `read` and prompts it (AC1). */
export interface FramingAgent {
  open(prompt: string): Promise<{ readonly session: FramingSession; readonly turn: FramingTurn }>;
}

/** The repository as it stands at the moment the spec became real (AC11). */
export interface RepoState {
  readonly cwd: string;
  readonly head: string;
  readonly branch: string;
}

export interface FramingInterviewOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly node: NodeId;
  readonly attempt: number;
  readonly epoch: number;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly provider: string;
  /** `null` for an adapter nothing has probed on this machine. */
  readonly capabilityRow: CapabilityRow | null;
  readonly packet: ContextPacket;
  readonly schemas: HandoffValidator;
  readonly tokenizer: Tokenizer;
  readonly agent: FramingAgent;
  readonly readRepo: () => Promise<RepoState>;
  readonly captureEvidence: (text: string) => Handle;
  /** Answers already given in this interview, replayed into the sealed spec. */
  readonly clarifications?: readonly ClarifyingExchange[];
}

export type FramingOutcome =
  | { readonly outcome: 'completed'; readonly spec: TaskSpec; readonly repairs: number }
  | {
      readonly outcome: 'suspended';
      readonly question: FramingQuestion;
      readonly session: FramingSession;
    }
  | { readonly outcome: 'failed'; readonly failure: NodeFailureError };

/** How the operator's answer reached the agent. Never `'delivered'` for a
 * replay — see the module note. */
export type FramingDelivery = 'steered' | 'replayed';

export interface FramingAnswerOptions extends FramingInterviewOptions {
  readonly session: FramingSession;
  readonly question: FramingQuestion;
  readonly answer: { readonly optionId: string; readonly text: string };
}

/** The `node.progress` phases this module writes, so the inspector can explain
 * the extra turn a replay costs. */
export const FRAMING_STEERED_PHASE = 'framing.answer-steered';
export const FRAMING_REPLAYED_PHASE = 'framing.answer-replayed';

/** AC11 — `head` and `branch` read from the real repository, right now. */
export async function gitRepoState(git: Git, cwd: string): Promise<RepoState> {
  const head = await git.run(['rev-parse', 'HEAD'], { cwd });
  const branch = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return { cwd, head: head.stdout.trim(), branch: branch.stdout.trim() };
}

function failed(options: FramingInterviewOptions, error: NodeFailureError): FramingOutcome {
  const failure = toNodeFailure(error, {
    // A framing node always has intake's `task.submitted` behind it, so the
    // ledger is never empty here; the floor is stated rather than assumed
    // because `seq` must be positive.
    occurredAtEvent: EventSeqSchema.parse(Math.max(1, headSeq(options.db))),
    attempt: options.attempt,
    captureEvidence: options.captureEvidence,
  });
  appendEvents(options.db, [
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'node.failed',
      v: 1,
      epoch: options.epoch,
      nodeId: options.node,
      attempt: options.attempt,
      payload: { node: options.node, attempt: options.attempt, failure },
    },
  ]);
  return { outcome: 'failed', failure: error };
}

/** AC7 — the question and the row it waits on, in one transaction. */
function suspend(
  options: FramingInterviewOptions,
  question: FramingQuestion,
  session: FramingSession,
): FramingOutcome {
  const wakeAt = Date.parse(question.deadline);
  options.db.transaction(() => {
    appendEvents(options.db, [
      {
        runId: options.runId,
        ts: options.ts,
        kind: 'human.requested',
        v: 1,
        epoch: options.epoch,
        nodeId: options.node,
        attempt: options.attempt,
        payload: {
          node: options.node,
          prompt: question.prompt,
          options: question.options,
          deadline: { wakeAt: question.deadline, onTimeout: 'escalate' },
        },
      },
    ]);
    scheduleWake(options.db, {
      runId: options.runId,
      nodeId: options.node,
      wakeAt,
      reason: 'human_gate',
    });
  });
  return { outcome: 'suspended', question, session };
}

/** AC2, AC10, AC11 — measure the return, repair once, seal, create the run. */
async function settle(
  options: FramingInterviewOptions,
  session: FramingSession,
  turn: FramingTurn,
): Promise<FramingOutcome> {
  const handoff = await enforceHandoff({
    db: options.db,
    runId: options.runId,
    node: options.node,
    nodeType: 'agent',
    attempt: options.attempt,
    epoch: options.epoch,
    ts: options.ts,
    contract: framingReturns(),
    structuredOutput: turn.structuredOutput,
    ...(turn.vendorRepairExhausted === undefined
      ? {}
      : { vendorRepairExhausted: turn.vendorRepairExhausted }),
    schemas: options.schemas,
    tokenizer: options.tokenizer,
    session,
  });

  if (handoff.outcome !== 'accepted') {
    return failed(
      options,
      handoff.failure ??
        new NodeFailureError(
          `the framing node ${options.node} returned no usable ${framingReturns().schemaId}`,
          { reason: 'contract.schema-invalid', class: 'permanent' },
        ),
    );
  }

  // AC8 — the operator's answers travel into the spec as `priorDecisions`, and
  // they are already in the ledger as `human.responded` independently of it.
  const document = withClarifyingAnswers(handoff.returned as never, options.clarifications ?? []);

  let spec: TaskSpec;
  try {
    spec = await sealTaskSpec(document);
  } catch (thrown) {
    return failed(
      options,
      new NodeFailureError(thrown instanceof Error ? thrown.message : String(thrown), {
        reason: 'contract.schema-invalid',
        class: 'permanent',
      }),
    );
  }

  const repo = await options.readRepo();
  appendEvents(options.db, [
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'run.created',
      v: 1,
      epoch: options.epoch,
      payload: {
        spec,
        cwd: repo.cwd,
        repo: { head: repo.head, branch: repo.branch },
      },
    },
  ]);

  return { outcome: 'completed', spec, repairs: handoff.repairs };
}

/**
 * AC1-AC3, AC10, AC11 — one framing attempt, from admission to `run.created`.
 *
 * Returns rather than throws on every arm, for the same reason `enforceHandoff`
 * does: whether the node retries is the scheduler's decision, and it needs the
 * failure as a value to make it.
 */
export async function runFramingInterview(
  options: FramingInterviewOptions,
): Promise<FramingOutcome> {
  const refusal = admitFraming(
    { node: options.node, provider: options.provider },
    options.capabilityRow,
  );
  if (refusal !== null) return failed(options, refusal);

  const { session, turn } = await options.agent.open(renderPacket(options.packet));
  if (turn.question !== null) return suspend(options, turn.question, session);
  return settle(options, session, turn);
}

/** The replayed prompt for an adapter that cannot be steered: the same packet,
 * plus the exchange the live session would have held in its own context. */
function replayPrompt(
  options: FramingAnswerOptions,
  exchanges: readonly ClarifyingExchange[],
): string {
  const replayed = exchanges
    .map((exchange) => `You asked: ${exchange.question}\nThe operator answered: ${exchange.answer}`)
    .join('\n\n');
  return (
    `${renderPacket(options.packet)}\n\n` +
    'This adapter cannot be steered mid-session, so this is a fresh session and the exchange ' +
    `below is replayed rather than remembered:\n\n${replayed}`
  );
}

/**
 * AC7, AC8 — the operator's answer, delivered and recorded.
 *
 * The `human.responded` event and the deletion of the `node_wake` row are one
 * transaction (`appendEventsConsumingWakes`); the delivery happens after it,
 * because an answer recorded but not delivered is recoverable and an answer
 * delivered but not recorded is not.
 */
export async function answerFramingQuestion(
  options: FramingAnswerOptions,
): Promise<FramingOutcome & { readonly delivery: FramingDelivery }> {
  appendEventsConsumingWakes(
    options.db,
    [
      {
        runId: options.runId,
        ts: options.ts,
        kind: 'human.responded',
        v: 1,
        epoch: options.epoch,
        nodeId: options.node,
        attempt: options.attempt,
        payload: {
          node: options.node,
          optionId: options.answer.optionId,
          text: options.answer.text,
          at: new Date(options.ts).toISOString(),
        },
      },
    ],
    [{ runId: options.runId, nodeId: options.node }],
  );

  const exchanges: readonly ClarifyingExchange[] = [
    ...(options.clarifications ?? []),
    { question: options.question.prompt, answer: options.answer.text },
  ];

  const delivery: FramingDelivery = options.session.steerable ? 'steered' : 'replayed';
  const { session, turn } = options.session.steerable
    ? { session: options.session, turn: await options.session.answer(options.answer.text) }
    : await options.agent.open(replayPrompt(options, exchanges));

  appendEvents(options.db, [
    {
      runId: options.runId,
      ts: options.ts,
      kind: 'node.progress',
      v: 1,
      epoch: options.epoch,
      nodeId: options.node,
      attempt: options.attempt,
      payload: {
        node: options.node,
        attempt: options.attempt,
        phase: delivery === 'steered' ? FRAMING_STEERED_PHASE : FRAMING_REPLAYED_PHASE,
        message:
          delivery === 'steered'
            ? 'the answer was sent into the live session'
            : 'the adapter advertises no mid-turn steering; the question and answer were ' +
              'replayed into a fresh session',
      },
    },
  ]);

  const next: FramingInterviewOptions = { ...options, clarifications: exchanges };
  if (turn.question !== null) {
    return { ...suspend(next, turn.question, session), delivery };
  }
  return { ...(await settle(next, session, turn)), delivery };
}
