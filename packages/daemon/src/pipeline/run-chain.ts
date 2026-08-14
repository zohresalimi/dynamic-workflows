/**
 * KAR-19.3 — the live chain: framing → the F1.3 gate → the pin → recon →
 * `PlanGraph` v1, called from the ticker.
 *
 * **This file writes nothing new.** Every step it performs already existed,
 * exported, documented and covered by its own suite before this story:
 * `runFramingInterview` (KAR-10.2) seals the `TaskSpec` and opens the gate;
 * `approveSpec` (KAR-10.3) appends the approval and the pin in one transaction;
 * `runReconNode` (KAR-10.5) surveys the repository and writes facts with
 * provenance; `compilePlanV1` (KAR-11.1) turns spec + facts + the probed
 * capability list into a validated `PlanGraph` and appends `plan.proposed`.
 * What did not exist was **a caller**, which is why every one of those suites
 * was green while an operator's run did nothing at all.
 *
 * So the whole of this module is scheduling and argument assembly, and its
 * hardest constraint is negative: **no second implementation of any step.**
 * `test/one-live-chain-caller.test.ts` asserts that mechanically, because the
 * pressure to write a small local planner "just to see a graph" is real and
 * arrives at about hour three.
 *
 * Four properties are load-bearing.
 *
 * **Nothing is compiled before approval (AC3).** `advanceRun` reads
 * `state.specApproved` and returns immediately while it is `null`. The gate is
 * not a formality to be raced: the spec is what every gate verdict is measured
 * against, and a rejection that arrives after a speculative compile has already
 * spent it.
 *
 * **Each step appends its own events as it completes (AC2).** There is no
 * batch, no staging area and no single transaction around the chain: the
 * operator watching `/runs/<id>` sees `spec.pinned`, then the recon facts, then
 * `plan.proposed`, in that order, because that is the order they happened in.
 * The difference between that and one frame at the end is the difference
 * between supervising a run and being told about it afterwards.
 *
 * **A wait is a row, never a promise (AC4).** A clarifying question suspends
 * onto `node_wake` inside `runFramingInterview`, and this file holds nothing
 * across it. The answer arrives through `POST /runs/:id/nodes/:nodeId/respond`
 * on a daemon that may be a different process, and the run is picked up again
 * because `framingIsPending` is a comparison of sequence numbers rather than a
 * flag somebody remembered to set. The resumed turn is a fresh session with the
 * exchange replayed into its packet — the honest shape for an adapter DeFlow
 * has not held a connection to for six hours.
 *
 * **Resume re-derives, and never re-frames (AC8).** Everything this module
 * decides is a function of `(ledger, now)`. A daemon killed between
 * `spec.pinned` and `plan.proposed` comes back, reads the same log, finds the
 * same pinned spec and compiles against it; the framing agent is not opened a
 * second time, and the `specHash` carried into the plan is the one the operator
 * approved.
 *
 * The one seam is `RunChainResolver`: which provider, which model, which
 * schemas directory, and the three agent ports. It is a port for the same
 * reason `BootOptions.probeProviders` is one — it needs to spawn vendor
 * binaries resolved against the operator's own `PATH`, which DeFlowd's
 * environment is not (docs/03-local-development.md §4.3). `DeFlow up` is the
 * production caller that supplies it.
 *
 * Verifies: EPIC-19-S16, EPIC-19-S18, EPIC-19-S19, EPIC-19-S20, EPIC-19-S21,
 * EPIC-19-S22 · AC1–AC5, AC8
 */
import type { CapabilityRow } from '@DeFlow/adapters';
import type {
  ClarifyingExchange,
  Constraint,
  Db,
  Event,
  Fact,
  FactSchemaRegistry,
  Handle,
  NodeId,
  PlannerFact,
  RunId,
  Segment,
  TaskSpec,
  Tokenizer,
} from '@DeFlow/core';
import {
  buildFramingPacket,
  buildSpecPinnedSegments,
  contextSegment,
  currentSpec,
  EventSeqSchema,
  NodeIdSchema,
  parseEvent,
  RECON_PERMISSION,
  renderPacket,
} from '@DeFlow/core';
import { lastSeqOfKinds, readRange, replayRun } from '@DeFlow/ledger';
import { join } from 'node:path';
import type { AdvanceInput, FramingWake } from '../drive.ts';
import type { FramingAgent } from '../framing/interview.ts';
import { gitRepoState, runFramingInterview } from '../framing/interview.ts';
import { Git } from '../git/git.ts';
import type { WorkspaceManager } from '../git/worktree-manager.ts';
import type { HandoffValidator } from '../handoff/enforce.ts';
import { log } from '../logging.ts';
import { compilePlanV1, type PlannerAgent } from '../plan/compile.ts';
import type { NodeRefChecker } from '../plan/validate.ts';
import type { ReconAgent } from '../recon/recon.ts';
import { runReconNode } from '../recon/recon.ts';
import { FRAMING_NODE } from '../spec/gate.ts';
import { framingIsPending } from './framing-schedule.ts';
import { noProviderFailure, unframeableRunFailure } from './turn-failure.ts';

const chain = log.child({ mod: 'chain' });

/** A pre-plan run's whole log fits far inside this. */
const EVENT_PAGE = 5_000;

/** The recon node's id, and the one node other than framing that may be
 * scheduled before the spec is approved (KAR-10.3 AC3, KAR-10.5). */
export const RECON_NODE: NodeId = NodeIdSchema.parse('recon');

/**
 * Where the recon node's detached worktree is provisioned.
 *
 * Exported because the agent that surveys it has to be *spawned in it*, and the
 * composition root is what constructs that agent: two expressions of the same
 * path is how a survey ends up read from the repository the run was submitted
 * from rather than from the detached copy it was supposed to observe.
 */
export const reconWorktreePath = (runDir: string): string =>
  join(runDir, 'worktrees', String(RECON_NODE));

/**
 * Everything one run's chain needs that cannot be read out of its ledger.
 *
 * Resolved per run rather than once per daemon, because the answer genuinely
 * differs per run: the repository is the run's own `cwd`, the schemas directory
 * is that repository's `.DeFlow/schemas`, and which provider serves the run is
 * a decision admission already made against the machine the daemon is on.
 */
export interface RunChainContext {
  /** The adapter admission chose for this run. */
  readonly provider: string;
  readonly model: string;
  readonly maxContext: number;
  /** The probed row, or `null` for an adapter nothing has shaken hands with —
   * which `admitFraming` refuses rather than guesses about. */
  readonly capabilityRow: CapabilityRow | null;
  readonly agents: {
    readonly framing: FramingAgent;
    readonly recon: ReconAgent;
    readonly planner: PlannerAgent;
  };
  /** Ajv over the run's `.DeFlow/schemas/`, `strict: true`, `allErrors: true`. */
  readonly schemas: HandoffValidator;
  /** The same store, as the blackboard's fact validator. */
  readonly registry: FactSchemaRegistry;
  readonly schemasDir: string;
  readonly tokenizer: Tokenizer;
  readonly workspace: WorkspaceManager;
  readonly refs: NodeRefChecker;
  /** `<data-dir>/runs/<runId>`, where the plan versions are written. */
  readonly runDir: string;
  readonly putSurvey: (bytes: Uint8Array) => Handle;
  readonly captureEvidence: (text: string) => Handle;
  /**
   * Reads a task source that was too large to inline back out of the blob
   * store (KAR-10.1 AC2's `handle` arm).
   *
   * A port for the same reason `putSurvey` is one: the bytes live in
   * `@DeFlow/ledger`'s content-addressed store under the data directory, and
   * which data directory this daemon is serving is `boot()`'s knowledge rather
   * than the chain's.
   */
  readonly readTaskSource: (handle: Handle) => string;
  /** The run's safety constraints (F5.6), pinned into every packet. */
  readonly constraints?: readonly Constraint[];
}

export type RunChainResolver = (input: {
  readonly runId: RunId;
  readonly db: Db;
  /** The repository the run was submitted against, as `task.submitted`
   * recorded it. */
  readonly cwd: string;
  /**
   * The daemon life this turn belongs to, as the driver handed it down.
   *
   * On the input rather than captured when the resolver was built, because
   * everything a resolver constructs that *writes* — the `WorkspaceManager`'s
   * worktree events above all — has to be stamped with the epoch of the daemon
   * that is running now. A resolver built at boot and holding its own copy
   * would be right until the first `bumpEpoch`, which is exactly the case
   * fencing exists for.
   */
  readonly epoch: number;
}) => Promise<RunChainContext | null>;

export interface RunChainPorts {
  readonly resolve: RunChainResolver;
}

export interface RunChain {
  /** The port `boot()` hands the driver: one due framing wake, performed. */
  runFraming: (wake: FramingWake) => Promise<void>;
  /** The post-approval half: pin → recon → compile, for one run. */
  advanceRun: (input: AdvanceInput) => Promise<void>;
}

/** The run's events, skipping any this build cannot read. */
function ledger(db: Db, runId: RunId): readonly Event[] {
  return readRange(db, runId, 0, EVENT_PAGE).events.flatMap((stored) => {
    const parsed = parseEvent(stored);
    return parsed.status === 'ok' ? [parsed.event] : [];
  });
}

/**
 * What intake recorded, verbatim — the text and the event that carries it.
 *
 * `raw` xor `handle` is structural in `TaskSubmittedSchema`: a source at or
 * under the inline threshold is in the event, and one over it is a handle into
 * the blob store. Both arms produce the same bytes, which is the whole of
 * KAR-10.1 AC3's *"byte-identical to what was submitted"*.
 */
function submittedTask(
  events: readonly Event[],
  read: (handle: Handle) => string,
): { text: string; sourceEvent: number } | null {
  for (const event of events) {
    if (event.kind !== 'task.submitted') continue;
    const { raw, handle } = event.payload;
    if (raw !== undefined) return { text: raw, sourceEvent: event.seq };
    if (handle !== undefined) return { text: read(handle), sourceEvent: event.seq };
    return null;
  }
  return null;
}

/** The repository the run was submitted against. */
function submittedCwd(events: readonly Event[]): string | null {
  for (const event of events) {
    if (event.kind === 'task.submitted') return event.payload.provenance.cwd ?? null;
  }
  return null;
}

/**
 * The clarifying questions this interview has already asked and had answered,
 * oldest first (AC4).
 *
 * Read off the log rather than held in memory, which is the whole of *"no
 * promise is kept across the suspension"*: the exchange survives a restart
 * because it was never anywhere else.
 */
function clarifications(events: readonly Event[]): readonly ClarifyingExchange[] {
  const exchanges: ClarifyingExchange[] = [];
  let asked: string | null = null;
  for (const event of events) {
    if (event.kind === 'human.requested' && event.payload.node === FRAMING_NODE) {
      asked = event.payload.prompt;
    }
    if (event.kind === 'human.responded' && event.payload.node === FRAMING_NODE) {
      if (asked !== null) exchanges.push({ question: asked, answer: event.payload.text ?? '' });
      asked = null;
    }
  }
  return exchanges;
}

/** The spec the operator rejected and why, for a second framing attempt's
 * packet (KAR-10.2 AC9). `null` on the first attempt. */
function rejection(
  events: readonly Event[],
): { readonly reason: string; readonly sourceEvent: number } | null {
  let latest: { reason: string; sourceEvent: number } | null = null;
  for (const event of events) {
    if (
      event.kind === 'human.responded' &&
      event.payload.node !== FRAMING_NODE &&
      event.payload.optionId === 'reject'
    ) {
      latest = { reason: event.payload.text ?? '', sourceEvent: event.seq };
    }
  }
  return latest;
}

/** The spec the last completed framing attempt produced, or `null`. */
function lastCreatedSpec(events: readonly Event[]): TaskSpec | null {
  let spec: TaskSpec | null = null;
  for (const event of events) {
    if (event.kind === 'run.created') spec = event.payload.spec;
  }
  return spec;
}

/**
 * How many framing attempts this run has already had rejected — the `attempt`
 * every event this turn appends is stamped with.
 */
const framingAttempt = (events: readonly Event[]): number =>
  events.filter(
    (event) =>
      event.kind === 'human.responded' &&
      event.payload.node !== FRAMING_NODE &&
      event.payload.optionId === 'reject',
  ).length;

/** A recon fact as the planner's packet takes it — the same values, addressed
 * by the vocabulary EPIC-11 reads. */
const plannerFact = (fact: Fact): PlannerFact => ({
  key: fact.key,
  confidence: fact.provenance.confidence,
  value: fact.value,
  fromEvidence: [...fact.provenance.fromEvidence],
  sourceEvent: fact.provenance.atEvent,
});

/**
 * The recon node's prompt: the pinned set at `read`, plus the approved spec.
 *
 * Assembled from `@DeFlow/core`'s own segment primitives and rendered by
 * `renderPacket` rather than by a second packet builder living here. There is
 * no `buildPacket` on this path because `buildPacket` pins a *plan node*, and
 * at recon time there is no plan — producing one is what the next step is for.
 */
async function reconPrompt(
  context: RunChainContext,
  spec: TaskSpec,
  sourceEvent: number,
): Promise<string> {
  const pinned = await buildSpecPinnedSegments({
    spec,
    ...(context.constraints === undefined ? {} : { constraints: context.constraints }),
    sourceEvent: EventSeqSchema.parse(sourceEvent),
  });
  const brief: Segment = await contextSegment({
    id: 'recon-brief',
    kind: 'task.brief',
    sourceEvent: EventSeqSchema.parse(sourceEvent),
    text:
      'Survey this repository so a plan can be compiled against the pinned spec above. You are ' +
      `at ${RECON_PERMISSION} permission: report only what you observed, and record nothing you ` +
      'did not.',
  });
  return renderPacket({ segments: [...pinned, brief] });
}

/**
 * Builds the chain one daemon life uses.
 *
 * Stateless: every decision below is re-derived from the ledger on every call,
 * which is what lets a second daemon pick up a run this one was half way
 * through without inheriting anything from it.
 */
export function createRunChain(ports: RunChainPorts): RunChain {
  async function runFraming(wake: FramingWake): Promise<void> {
    const { db, runId, epoch, now } = wake;
    const events = ledger(db, runId);
    // KAR-19.9 AC1 — every way out of this function that is not a turn is a
    // *throw*, so the driver journals it, classifies it against the node's own
    // policy and ends the run when the attempts are spent. Returning quietly is
    // what left the reported run's wake due for ever with nothing in its ledger
    // to say why, and a `chain.warn` is a line in a file the operator had no
    // reason to open. The failures themselves are constructed in
    // `./turn-failure.ts`: this file may not name a `NodeFailureReason` (AC2).
    const cwd = submittedCwd(events);
    if (cwd === null) {
      throw unframeableRunFailure(
        `run ${runId}'s task.submitted names no repository, so this build cannot frame it; ` +
          'it was submitted before intake recorded one (KAR-19.3)',
      );
    }

    const context = await ports.resolve({ runId, db, cwd, epoch });
    if (context === null) throw noProviderFailure(runId);

    const task = submittedTask(events, context.readTaskSource);
    if (task === null) {
      throw unframeableRunFailure(
        `run ${runId} has no task.submitted, so there is nothing to frame`,
      );
    }
    // Belt to the driver's braces: the wake could have been written before an
    // answer landed, and framing a run that is no longer owed a turn would
    // produce a second spec nothing downstream agrees with.
    if (!framingIsPending(db, runId)) return;

    const attempt = framingAttempt(events);
    const refused = rejection(events);
    const rejected = lastCreatedSpec(events);
    const answered = clarifications(events);

    const packet = await buildFramingPacket({
      runId,
      nodeId: FRAMING_NODE,
      attempt,
      builtAtEvent: task.sourceEvent,
      target: {
        provider: context.provider,
        model: context.model,
        maxContext: context.maxContext,
      },
      task: { text: task.text, sourceEvent: task.sourceEvent },
      ...(context.constraints === undefined ? {} : { constraints: context.constraints }),
      ...(refused === null || rejected === null
        ? {}
        : {
            rejected: {
              spec: rejected,
              reason: refused.reason,
              sourceEvent: refused.sourceEvent,
            },
          }),
      ...(answered.length === 0
        ? {}
        : {
            segments: [
              await contextSegment({
                id: 'clarifying-answers',
                kind: 'task.brief',
                sourceEvent: EventSeqSchema.parse(task.sourceEvent),
                text:
                  'You asked for clarification and the operator answered. This is a fresh ' +
                  'session, so the exchange is replayed rather than remembered:\n\n' +
                  answered
                    .map(
                      (one) => `You asked: ${one.question}\nThe operator answered: ${one.answer}`,
                    )
                    .join('\n\n'),
              }),
            ],
          }),
    });

    const outcome = await runFramingInterview({
      db,
      runId,
      node: FRAMING_NODE,
      attempt,
      epoch,
      ts: now,
      provider: context.provider,
      capabilityRow: context.capabilityRow,
      packet,
      schemas: context.schemas,
      tokenizer: context.tokenizer,
      agent: context.agents.framing,
      // AC11 of KAR-10.2 — `head` and `branch` read from the real repository at
      // the instant the spec becomes real, not carried down from intake:
      // minutes of interview can pass between the two, and a stale head is a
      // run created against a commit it never saw.
      readRepo: () => gitRepoState(new Git(cwd), cwd),
      captureEvidence: context.captureEvidence,
      ...(answered.length === 0 ? {} : { clarifications: answered }),
    });

    // The interview has already journalled its own `node.failed` for this
    // attempt; what it has *not* done is decide whether the node retries, which
    // is the scheduler's call and needs the failure as a value to make it (the
    // interview's own module note). Rethrowing is how it gets there, and
    // `recordTurnFailure` sees the record is already in the ledger and adds the
    // classification rather than a second copy of the failure.
    if (outcome.outcome === 'failed') throw outcome.failure;
  }

  async function advanceRun(input: AdvanceInput): Promise<void> {
    const { db, runId, epoch, now } = input;
    const state = replayRun(db, runId).state;

    // AC3 — the gate is a real gate. Nothing below this line runs while the
    // operator is still reading the spec, and `compilePlanV1` is not called
    // even speculatively.
    if (state.specApproved === null) return;
    if (state.plan !== null) return;

    const pinned = lastSeqOfKinds(db, runId, ['spec.pinned']);
    if (pinned === null) return;
    // A run the compiler already escalated is a decision for the operator, not
    // a loop: two failed attempts have been made and §3.5 forbids a third
    // automatic one.
    const escalated = lastSeqOfKinds(db, runId, ['run.needs_human']);
    if (escalated !== null && escalated > pinned) return;

    const events = ledger(db, runId);
    const spec = await currentSpec(events);
    if (spec === null) return;
    const cwd = submittedCwd(events);
    if (cwd === null) return;

    const context = await ports.resolve({ runId, db, cwd, epoch });
    if (context === null) {
      chain.warn(
        { runId },
        `no provider could be resolved for run ${runId}, so its plan was not compiled`,
      );
      return;
    }

    // ── recon, appending its own facts as it establishes them (AC2) ─────────
    const repo = repoOf(events);
    const recon = await runReconNode({
      db,
      runId,
      node: RECON_NODE,
      attempt: 0,
      epoch,
      ts: now,
      provider: context.provider,
      model: context.model,
      workspace: context.workspace,
      worktree: {
        path: reconWorktreePath(context.runDir),
        baseRef: repo?.head ?? 'HEAD',
      },
      scopePaths: spec.scope.included,
      prompt: await reconPrompt(context, spec, pinned),
      agent: context.agents.recon,
      schemas: context.schemas,
      registry: context.registry,
      tokenizer: context.tokenizer,
      putSurvey: context.putSurvey,
      captureEvidence: context.captureEvidence,
    });

    if (recon.outcome === 'failed') {
      chain.warn(
        { runId, reason: recon.failure.deflowFailure.reason },
        `recon for ${runId} did not complete; the planner is given the ${recon.facts.length} ` +
          'facts DeFlow established for itself rather than nothing',
      );
    }

    // ── the plan, from spec + facts + the probed capability manifest ────────
    //
    // `probedEvent` is the provenance the capability segment points at. The
    // `provider.probed` row is the honest answer where there is one; where
    // admission admitted the run without recording a probe, the pin is used
    // instead — a real event in this run's own log, rather than a zero.
    const probedEvent = lastSeqOfKinds(db, runId, ['provider.probed']) ?? pinned;

    const compiled = await compilePlanV1({
      db,
      runId,
      node: PLANNER_NODE,
      epoch,
      ts: now,
      runDir: context.runDir,
      spec,
      ...(context.constraints === undefined ? {} : { constraints: context.constraints }),
      facts: recon.facts.map(plannerFact),
      probedEvent,
      provider: context.provider,
      model: context.model,
      maxContext: context.maxContext,
      schemas: context.schemas,
      schemasDir: context.schemasDir,
      agent: context.agents.planner,
      refs: context.refs,
    });

    if (compiled.outcome === 'failed') {
      chain.error(
        { runId, reason: compiled.failure.deflowFailure.reason },
        `compiling a plan for ${runId} failed: ${compiled.failure.message}`,
      );
    }
  }

  return { runFraming, advanceRun };
}

/** The planner node's id, so the events it appends are attributable. */
export const PLANNER_NODE: NodeId = NodeIdSchema.parse('planner');

/** `repo` as `run.created` recorded it, or `null` before there is one. */
function repoOf(events: readonly Event[]): { head: string; branch: string } | null {
  let repo: { head: string; branch: string } | null = null;
  for (const event of events) {
    if (event.kind === 'run.created') repo = event.payload.repo;
  }
  return repo;
}
