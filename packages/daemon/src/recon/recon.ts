/**
 * KAR-10.5 — the recon node: survey a repository at `read`, and leave typed
 * facts behind rather than a report (docs/06-planning-and-replanning.md §2.1).
 *
 * The shape of this file is the story. Five steps, in this order, and the order
 * is what makes each one honest:
 *
 *   1. **Provision a detached, locked worktree** (AC1). `--detach` because a
 *      read node needs no branch and git will not check the same branch out
 *      twice; `--lock` inside the same `add` because the gap between an add and
 *      a separate lock is a window in which DeFlow's own reaper can prune a live
 *      worktree (KAR-07.2). Never `--force`, anywhere.
 *   2. **Survey it** — DeFlow's own file reads, before the agent has said
 *      anything. What the daemon can establish for itself, it establishes for
 *      itself.
 *   3. **Offload the whole survey to the CAS** (AC6), *before* the return is
 *      measured. The handle is then available as evidence whatever the agent
 *      does, and the full listing is lossless in the blob store rather than
 *      truncated into a fact body.
 *   4. **Take the agent's return through `enforceHandoff`** at the recon
 *      contract — `DeFlow.reconsurvey.v1` at 4,000 tokens — which appends
 *      `handoff.oversize`, repairs exactly once, and never shortens anything.
 *   5. **Write the facts**, each through `writeFact`, which is the blackboard's
 *      only door: acceptance first, then `fact.written`, then the projection.
 *
 * **A failed session still leaves facts.** If the agent returns nothing usable,
 * the observations are still real — the manifest was read, the paths were
 * counted, the gates were catalogued — and `deriveReconFacts(null, …)` writes
 * exactly what DeFlow saw with no claim folded in. The node is still recorded as
 * failed. Discarding the survey because the model's document was invalid would
 * throw away the verified half to punish the speculative one.
 *
 * **The worktree goes back on both paths, and its removal can change the
 * outcome.** A recon node that failed still holds a locked worktree, and a
 * locked worktree is immune to `prune` — which is the property that makes it
 * crash-safe and the property that makes leaking one permanent. So the removal
 * is not a `finally` that would swallow or mask what happened: a node whose
 * worktree could not go back is a failed node, even though its facts are
 * already durable.
 *
 * **The occupancy refusal returns rather than escapes** (KAR-26.1 AC3): a
 * `provision` refused because somebody else holds the path is a failed recon
 * node, journalled and returned, not an exception the driver logs. The
 * distinction is not stylistic — an escaping throw reached `advanceOneRun`'s
 * catch, which writes a line to the daemon's own log and returns, leaving
 * nothing in the ledger to say the node failed and therefore nothing to stop
 * the next tick trying again. It is scoped to that one refusal because it is
 * the one no retry can clear; every other provisioning failure still escapes,
 * and is still the driver's to re-attempt.
 *
 * Verifies: EPIC-10-S24, EPIC-10-S25, EPIC-10-S26, EPIC-10-S27, EPIC-10-S28 ·
 * AC1-AC6, AC8
 * Verifies: EPIC-26-S04, EPIC-26-S06 · KAR-26.1 AC3
 */

import type {
  Db,
  Fact,
  FactSchemaRegistry,
  Handle,
  NodeId,
  ReconFactCandidate,
  ReconSurvey,
  RunId,
  StructuredOutput,
  Tokenizer,
} from '@DeFlow/core';
import {
  canonicalJson,
  deriveReconFacts,
  EventSeqSchema,
  NodeFailureError,
  RECON_PERMISSION,
  reconReturns,
  toNodeFailure,
} from '@DeFlow/core';
import { appendEvents, headSeq, writeFact } from '@DeFlow/ledger';
import { createHash } from 'node:crypto';
import type { ProvisionRead, ProvisionResult, WorkspaceManager } from '../git/worktree-manager.ts';
import { WorktreePathOccupiedError } from '../git/worktree-manager.ts';
import { enforceHandoff, type HandoffSession, type HandoffValidator } from '../handoff/enforce.ts';
import { type RepoSurveyDocument, surveyRepository } from './survey.ts';

/**
 * AC1 — a recon node's worktree, stated once.
 *
 * `mode: 'read'` *is* `RECON_PERMISSION` in the vocabulary `worktreeAddArgs`
 * speaks, and composing the request here rather than at each call site is what
 * keeps the two from drifting: a recon node scheduled at `read` whose worktree
 * was provisioned for writing would pass every test in this file and be wrong.
 */
export function reconProvisionRequest(input: {
  readonly runId: string;
  readonly nodeId: string;
  readonly path: string;
  readonly baseRef: string;
}): ProvisionRead {
  if (RECON_PERMISSION !== 'read') {
    throw new Error('a recon node is a read node; its worktree cannot be provisioned for writing');
  }
  return { mode: 'read', ...input };
}

/** One turn of a recon session. */
export interface ReconTurn {
  readonly structuredOutput: StructuredOutput;
  /** AC7 of KAR-09.9: the vendor already spent its own bounded repair loop. */
  readonly vendorRepairExhausted?: boolean;
}

/** Opens a session at `read` and prompts it. */
export interface ReconAgent {
  open(prompt: string): Promise<{ readonly session: HandoffSession; readonly turn: ReconTurn }>;
}

export interface ReconNodeOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly node: NodeId;
  readonly attempt: number;
  readonly epoch: number;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  /** Stamped on every fact's provenance, verbatim. */
  readonly provider: string;
  readonly model: string;
  readonly workspace: WorkspaceManager;
  readonly worktree: { readonly path: string; readonly baseRef: string };
  /** The areas the spec named, repo-relative. */
  readonly scopePaths: readonly string[];
  /** The rendered context packet this node is prompted with. */
  readonly prompt: string;
  readonly agent: ReconAgent;
  readonly schemas: HandoffValidator;
  readonly registry: FactSchemaRegistry;
  readonly tokenizer: Tokenizer;
  /** Writes the full survey to the CAS and returns its handle (AC6). */
  readonly putSurvey: (bytes: Uint8Array) => Handle;
  readonly captureEvidence: (text: string) => Handle;
}

export type ReconOutcome =
  | {
      readonly outcome: 'completed';
      readonly facts: readonly Fact[];
      /** `artifact://<sha256>` of the full survey. */
      readonly survey: Handle;
      /** 0 or 1. */
      readonly repairs: number;
    }
  | {
      readonly outcome: 'failed';
      readonly failure: NodeFailureError;
      /** The observations are real even when the session was not, so the facts
       * DeFlow established for itself are still here. */
      readonly facts: readonly Fact[];
      /** `null` when the failure happened before the survey was offloaded. */
      readonly survey: Handle | null;
    };

/**
 * `fact_<26 hex>`, derived from the run, the node, the attempt and the key.
 *
 * Deterministic rather than random so a replayed attempt mints the same id: the
 * `fact` row's `ON CONFLICT DO NOTHING` then makes a re-run of the same attempt
 * idempotent instead of doubling the blackboard.
 */
export function reconFactId(runId: string, node: string, attempt: number, key: string): string {
  const digest = createHash('sha256').update(`${runId} ${node} ${attempt} ${key}`);
  return `fact_${digest.digest('hex').slice(0, 26)}`;
}

/** A candidate, plus the envelope only the ledger's seq and the node's identity
 * can fill. */
function envelopeFor(
  options: ReconNodeOptions,
  candidate: ReconFactCandidate,
  atEvent: number,
): unknown {
  return {
    id: reconFactId(options.runId, options.node, options.attempt, candidate.key),
    key: candidate.key,
    kind: candidate.kind,
    schemaId: candidate.schemaId,
    value: candidate.value,
    provenance: {
      byNode: options.node,
      byProvider: options.provider,
      byModel: options.model,
      fromEvidence: [...candidate.fromEvidence],
      atEvent,
      at: new Date(options.ts).toISOString(),
      confidence: candidate.confidence,
    },
  };
}

/** A refused fact is a bug in this module, not in the agent: the candidates are
 * built here and validated against a schema shipped in the same commit. */
class ReconFactRefused extends Error {
  constructor(key: string, message: string) {
    super(`the recon fact "${key}" was refused by the blackboard: ${message}`);
    this.name = 'ReconFactRefused';
  }
}

function writeFacts(
  options: ReconNodeOptions,
  candidates: readonly ReconFactCandidate[],
): readonly Fact[] {
  const written: Fact[] = [];
  for (const candidate of candidates) {
    const atEvent = EventSeqSchema.parse(Math.max(1, headSeq(options.db)));
    const result = writeFact(
      options.db,
      options.registry,
      envelopeFor(options, candidate, atEvent),
      {
        runId: options.runId,
        ts: options.ts,
        epoch: options.epoch,
        attempt: options.attempt,
      },
    );
    if (!result.ok) throw new ReconFactRefused(candidate.key, result.error.message);
    written.push(result.fact);
  }
  return written;
}

function appendFailure(options: ReconNodeOptions, error: unknown): NodeFailureError {
  const failure = toNodeFailure(error, {
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
  return error instanceof NodeFailureError
    ? error
    : new NodeFailureError(failure.message, { reason: failure.reason, class: failure.class });
}

/** The survey as the bytes that go to the CAS: canonical JSON, so two identical
 * surveys mint one handle. */
function surveyBytes(document: RepoSurveyDocument): Uint8Array {
  return Buffer.from(canonicalJson(document), 'utf8');
}

/**
 * AC1-AC6, AC8 — one recon attempt, from `worktree add` to the last
 * `fact.written`.
 *
 * Returns rather than throws on every arm, for the same reason `enforceHandoff`
 * does: whether the node retries is the scheduler's decision, and it needs the
 * failure as a value to make it.
 */
export async function runReconNode(options: ReconNodeOptions): Promise<ReconOutcome> {
  let provisioned: ProvisionResult;
  try {
    provisioned = await options.workspace.provision(
      reconProvisionRequest({
        runId: options.runId,
        nodeId: options.node,
        path: options.worktree.path,
        baseRef: options.worktree.baseRef,
      }),
    );
  } catch (thrown) {
    // KAR-26.1 AC3 — folded into the outcome rather than escaping, and that is
    // the whole difference between a failure and a haunting. An escaped throw
    // reached `advanceOneRun`'s catch, which logs and returns: nothing recorded
    // the node as failed, so the next tick tried again, and a deterministic
    // refusal — a worktree locked by somebody else, which no retry can free —
    // printed itself once per second for ever. As a value it reaches
    // `recordTurnFailure`, which classifies it and, for a gate, suspends the
    // node and asks a person.
    //
    // **Only that one refusal.** Every other way `provision` can fail is a
    // failure recon might get past next time — a salvage a `pre-commit` hook
    // refused, a busy index, a base ref that does not resolve — and folding
    // those into an outcome would hand `advanceRun` a `failed` recon with no
    // facts in it, which it compiles a plan from. A run permanently committed
    // to a plan built on nothing is a worse end than a retry, so they stay the
    // driver's to log and re-attempt.
    if (!(thrown instanceof WorktreePathOccupiedError)) throw thrown;
    return {
      outcome: 'failed',
      failure: appendFailure(options, thrown),
      facts: [],
      survey: null,
    };
  }

  const outcome = await surveyAndSettle(options, provisioned.path);

  // Not a `finally`: a removal that fails must change the outcome rather than
  // replace it. A locked worktree is immune to `prune` — which is what makes it
  // crash-safe and what makes leaking one permanent — so a node whose worktree
  // is still there is a node a human has to look at, even though its facts are
  // already durable.
  try {
    await options.workspace.remove({
      runId: options.runId,
      nodeId: options.node,
      path: provisioned.path,
    });
  } catch (thrown) {
    return {
      outcome: 'failed',
      failure: appendFailure(options, thrown),
      facts: outcome.facts,
      survey: outcome.survey,
    };
  }

  return outcome;
}

/** Steps 2-5: everything that happens while the worktree exists. */
async function surveyAndSettle(options: ReconNodeOptions, worktree: string): Promise<ReconOutcome> {
  try {
    const document = await surveyRepository({
      root: worktree,
      scopePaths: options.scopePaths,
    });
    const surveyHandle = options.putSurvey(surveyBytes(document));

    const facts = (survey: ReconSurvey | null): readonly Fact[] =>
      writeFacts(
        options,
        deriveReconFacts({ survey, observation: document.observation, surveyHandle }),
      );

    const { session, turn } = await options.agent.open(options.prompt);
    const handoff = await enforceHandoff({
      db: options.db,
      runId: options.runId,
      node: options.node,
      nodeType: 'agent',
      attempt: options.attempt,
      epoch: options.epoch,
      ts: options.ts,
      contract: reconReturns(),
      structuredOutput: turn.structuredOutput,
      ...(turn.vendorRepairExhausted === undefined
        ? {}
        : { vendorRepairExhausted: turn.vendorRepairExhausted }),
      schemas: options.schemas,
      tokenizer: options.tokenizer,
      session,
    });

    if (handoff.outcome !== 'accepted') {
      // The observations stand on their own — see the module note.
      const observed = facts(null);
      const failure = appendFailure(
        options,
        handoff.failure ??
          new NodeFailureError(
            `the recon node ${options.node} returned no usable ${reconReturns().schemaId}`,
            { reason: 'contract.schema-invalid', class: 'permanent' },
          ),
      );
      return { outcome: 'failed', failure, facts: observed, survey: surveyHandle };
    }

    return {
      outcome: 'completed',
      facts: facts(handoff.returned as ReconSurvey),
      survey: surveyHandle,
      repairs: handoff.repairs,
    };
  } catch (thrown) {
    const failure = appendFailure(options, thrown);
    return { outcome: 'failed', failure, facts: [], survey: null };
  }
}
