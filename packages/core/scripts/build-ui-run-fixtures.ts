/**
 * KAR-16.3 — builds the two run fixtures the projection suite folds that no
 * recorded ledger in the repository covers yet: `happy-path-12` and
 * `three-patches`.
 *
 * ## Provenance, stated plainly
 *
 * `compaction/` and `gate-failure-repair/` are **recorded**: a real packet
 * builder demoted a real oversized body, and a real repair loop failed a real
 * `tsc`. These two are **assembled**, and the difference is worth naming rather
 * than burying, because [EPIC-16 KAR-16.5](../../../docs/delivery/epics/EPIC-16-ui-foundation.md)
 * is explicit that the six-fixture corpus must be *recorded from mock-agent
 * runs, never hand-written* — and it is equally explicit about why that story
 * cannot start yet: it depends on `DeFlow run` (EPIC-18 KAR-18.3), which does
 * not exist. Its own note names the interim this file implements:
 *
 * > If EPIC-18 slips, the honest interim is to record fixtures from the mock
 * > agent driven by the orchestrator's own test harness rather than to
 * > hand-write them — never the latter.
 *
 * So three things keep this file from being the hand-written fixture that note
 * refuses:
 *
 * 1. **Nothing here authors a payload shape.** Every packet comes out of
 *    `buildPacket`, every plan hash out of `planHash`, every fact out of
 *    `FactSchema`, and — the load-bearing one — **every envelope is written
 *    through `parseEvent` before it is serialised**. An event this build cannot
 *    read is a failed build, not a fixture.
 * 2. **It is regenerated and compared**, by
 *    `packages/core/test/integration/ui-run-fixtures.test.ts`, so a change to
 *    the `Event` union fails there rather than leaving a view held to a
 *    contract nothing produces.
 * 3. **It is deliberately replaceable.** When KAR-16.5 lands, the recording
 *    replaces the assembly at the same two paths and the projection suite does
 *    not move.
 *
 * ## The sequence has holes, on purpose
 *
 * `seq` is one global `AUTOINCREMENT` shared by every run in a data directory,
 * so a single run's cursor walks a strided subsequence of it. A fixture whose
 * numbers were 1..n would let a client that quietly assumed `seq + 1` pass
 * (docs/11-api-and-realtime.md §4.2).
 *
 * Usage: `node packages/core/scripts/build-ui-run-fixtures.ts [dir]`
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPacket } from '../src/build-packet.ts';
import { EVENT_CURRENT_VERSIONS, type EventKind } from '../src/event-payloads.ts';
import { type Event, parseEvent } from '../src/events.ts';
import { planHash } from '../src/hash.ts';
import { type EventSeq, EventSeqSchema, type NodeId } from '../src/ids.ts';
import { mapChildId } from '../src/map-child-id.ts';
import { contextSegment } from '../src/pinned-set.ts';
import type { PlanGraph } from '../src/plan-graph.ts';
import { PLANGRAPH_SCHEMA_ID, PlanGraphSchema } from '../src/plan-graph.ts';
import { type TaskSpec, TaskSpecSchema } from '../src/task-spec.ts';

/** Where the committed fixtures live, relative to this file. */
export const RUN_FIXTURES_DIR = fileURLToPath(
  new URL('../../../test/fixtures/runs/', import.meta.url),
);

export const HAPPY_PATH_RUN = 'run_20260811T090000Z_a1b2c3';
export const THREE_PATCHES_RUN = 'run_20260811T101500Z_b7c9d2';

/** A fixed instant: a fixture that moved with the clock could not be diffed. */
const T0 = Date.UTC(2026, 7, 11, 9, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const EPOCH = 3;

const SPEC_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);

const hex = (seed: string, length: number): string => {
  // A deterministic filler, not a hash: these stand in for digests the run
  // never computed, and a value that looked like a real sha256 of real bytes
  // would invite somebody to try to resolve it.
  let out = '';
  for (let index = 0; out.length < length; index += 1) {
    out += ((seed.charCodeAt(index % seed.length) * (index + 7)) % 16).toString(16);
  }
  return out.slice(0, length);
};

/** An `EventSeq`, through its own schema — the brand has one constructor. */
const eventSeq = (value: number): EventSeq => EventSeqSchema.parse(value);

const sha256 = (seed: string): string => `sha256-${hex(seed, 64)}`;
const bareSha = (seed: string): string => hex(seed, 64);
const handle = (seed: string): string => `artifact://${hex(seed, 64)}`;
const factId = (seed: string): string => `fact_${hex(seed, 26).replaceAll(/[^a-z0-9]/g, '0')}`;

/**
 * An envelope, with `seq` allocated by the caller and the payload version read
 * off the registry rather than written as a literal.
 *
 * A literal `1` per call site is right until the first version bump and then
 * wrong silently — an event written at `v: 1` carrying a v2 payload is refused
 * at read time, which for a fixture means at the moment somebody is debugging
 * something else.
 */
interface Draft {
  readonly seq: number;
  readonly kind: EventKind;
  readonly payload: unknown;
  readonly ts?: number;
  readonly nodeId?: string;
  readonly attempt?: number;
}

function envelopes(runId: string, drafts: readonly Draft[]): Event[] {
  return drafts.map((draft) => {
    const candidate = {
      seq: draft.seq,
      runId,
      ts: draft.ts ?? T0 + draft.seq * 1_000,
      kind: draft.kind,
      v: EVENT_CURRENT_VERSIONS[draft.kind],
      epoch: EPOCH,
      ...(draft.nodeId === undefined ? {} : { nodeId: draft.nodeId }),
      ...(draft.attempt === undefined ? {} : { attempt: draft.attempt }),
      payload: draft.payload,
    };

    const parsed = parseEvent(candidate);
    if (parsed.status !== 'ok') {
      throw new Error(
        `seq ${draft.seq} (${draft.kind}) is not an event this build can read: ` +
          `${JSON.stringify(parsed)}`,
      );
    }
    return parsed.event;
  });
}

// ── the plan documents ───────────────────────────────────────────────────────

const RETRY = { maxAttempts: 3, backoff: { base: 1_000, cap: 30_000, jitter: 'full' } } as const;

interface AgentOptions {
  readonly deps?: readonly string[];
  readonly provider?: string;
  readonly permission?: 'none' | 'read' | 'worktree' | 'full';
  readonly writes?: readonly { kind: 'fact'; key: string; schemaId: string }[];
  readonly lifecycle?: 'active' | 'abandoned';
}

/**
 * A plan node as a plain document.
 *
 * Deliberately not typed as `PlanNode`: the ids, gate ids and criterion ids in
 * this file are string literals, and `NodeId` and friends are branded types
 * whose only legitimate constructor is their own schema. `PlanGraphSchema.parse`
 * in `seal` below is what turns these into the branded document — one
 * validation, at the boundary, exactly as the daemon does it.
 */
type NodeDocument = Record<string, unknown>;
type EdgeDocument = Record<string, unknown>;

function agentNode(id: string, title: string, options: AgentOptions = {}): NodeDocument {
  return {
    id,
    title,
    type: 'agent',
    deps: [...(options.deps ?? [])],
    lifecycle: options.lifecycle ?? 'active',
    reads: [{ kind: 'spec', section: 'goal' }],
    writes: [...(options.writes ?? [])],
    permission: options.permission ?? 'worktree',
    pathScopes: { write: ['src/**'], read: ['src/**'] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 4_000 },
    retry: structuredClone(RETRY),
    budget: { maxCostUsd: 2, maxWallClockMs: 600_000 },
    brief: `${title}, and report what changed.`,
    provider: { prefer: [options.provider ?? 'claude-code'], requires: ['structuredOutput'] },
    resume: 'native-if-available',
  };
}

function gateNode(
  id: string,
  title: string,
  gateId: string,
  deps: readonly string[],
): NodeDocument {
  return {
    id,
    title,
    type: 'gate',
    deps: [...deps],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.verdict.v4', maxTokens: 300 },
    retry: { maxAttempts: 1, backoff: { base: 0, cap: 0, jitter: 'full' } },
    budget: {},
    gate: { kind: 'deterministic', gateId },
    criteria: [`${gateId}-clean`],
    independence: { notSessionOf: [...deps], preferDifferentProvider: true },
  };
}

function humanNode(id: string, title: string, deps: readonly string[]): NodeDocument {
  return {
    id,
    title,
    type: 'human',
    deps: [...deps],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.humandecision.v1', maxTokens: 200 },
    retry: { maxAttempts: 1, backoff: { base: 0, cap: 0, jitter: 'full' } },
    budget: {},
    prompt: 'Ship the migration?',
    options: [
      { id: 'ship', label: 'Ship it', effect: 'approve' },
      { id: 'hold', label: 'Hold', effect: 'reject' },
    ],
  };
}

function toolNode(id: string, title: string, run: string, deps: readonly string[]): NodeDocument {
  return {
    id,
    title,
    type: 'tool',
    deps: [...deps],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: ['**'] },
    returns: { schemaId: 'DeFlow.lintresult.v1', maxTokens: 500 },
    retry: { maxAttempts: 2, backoff: { base: 500, cap: 5_000, jitter: 'full' } },
    budget: { maxWallClockMs: 60_000 },
    tool: { kind: 'script', run, cwd: '.' },
    effectClass: 'pure',
  };
}

/** Seals a graph: `planHash` over the canonical document, as the daemon does. */
async function seal(
  runId: string,
  version: number,
  parent: string | null,
  nodes: readonly NodeDocument[],
  edges: readonly EdgeDocument[],
): Promise<PlanGraph> {
  const unsealed = {
    schemaId: PLANGRAPH_SCHEMA_ID,
    runId,
    version,
    planHash: sha256('placeholder'),
    parent,
    taskSpecHash: sha256('spec'),
    createdBy: version === 1 ? 'planner' : 'planner',
    createdAt: new Date(T0).toISOString(),
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
  };
  return PlanGraphSchema.parse({ ...unsealed, planHash: await planHash(unsealed) });
}

/** The twelve nodes of `happy-path-12`, and the edges between them. */
async function happyPathPlan(): Promise<PlanGraph> {
  const nodes: NodeDocument[] = [
    agentNode('recon-auth-surface', 'Survey the auth surface', {
      permission: 'read',
      writes: [{ kind: 'fact', key: 'finding/auth-uses-jwt', schemaId: 'DeFlow.finding.v1' }],
    }),
    agentNode('plan-migration', 'Plan the migration', { deps: ['recon-auth-surface'] }),
    agentNode('impl-login', 'Migrate the login view', { deps: ['plan-migration'] }),
    agentNode('impl-signup', 'Migrate the signup view', { deps: ['plan-migration'] }),
    agentNode('impl-logout', 'Migrate the logout view', { deps: ['plan-migration'] }),
    agentNode('impl-profile', 'Migrate the profile view', { deps: ['plan-migration'] }),
    agentNode('impl-legacy-shim', 'Keep the legacy shim alive', { deps: ['plan-migration'] }),
    gateNode('gate-typecheck', 'The project typechecks', 'typecheck', ['impl-signup']),
    gateNode('gate-contract', 'The API contract holds', 'contract', ['impl-signup']),
    agentNode('review-security', 'Review the auth changes', {
      deps: ['gate-typecheck'],
      provider: 'codex',
      permission: 'read',
    }),
    humanNode('approve-release', 'Operator approves the release', ['review-security']),
    toolNode('smoke-tests', 'Run the smoke tests', 'pnpm test:smoke', ['approve-release']),
  ];

  const edges: EdgeDocument[] = [
    // The one edge F10.1's "edges labelled with what flows" is about: a data
    // edge naming the fact that crosses it, so the renderer draws the fact
    // rather than an arrow.
    {
      from: 'recon-auth-surface',
      to: 'plan-migration',
      kind: 'data',
      carries: ['finding/auth-uses-jwt'],
    },
    ...['impl-login', 'impl-signup', 'impl-logout', 'impl-profile', 'impl-legacy-shim'].map(
      (to): EdgeDocument => ({ from: 'plan-migration', to, kind: 'control' }),
    ),
    { from: 'impl-signup', to: 'gate-typecheck', kind: 'control' },
    { from: 'impl-signup', to: 'gate-contract', kind: 'control' },
    { from: 'gate-typecheck', to: 'review-security', kind: 'control' },
    { from: 'review-security', to: 'approve-release', kind: 'control' },
    { from: 'approve-release', to: 'smoke-tests', kind: 'control' },
  ];

  return await seal(HAPPY_PATH_RUN, 1, null, nodes, edges);
}

// ── context packets ──────────────────────────────────────────────────────────

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(SPEC_FIXTURE, 'utf8'));
  draft.approvedBy = { at: '2026-08-11T08:55:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

/**
 * One packet record, built by the production builder and stripped of segment
 * text exactly as `context.built` records it (§9).
 *
 * Every one of the nine `SegmentKind`s is present, because AC6's assertion —
 * per-kind sums equal `totals.byKind` for **all nine** — is only worth making
 * over a packet that has all nine.
 */
async function packetRecord(nodeId: string, attempt: number, builtAtEvent: number, spec: TaskSpec) {
  const segments = await Promise.all([
    contextSegment({
      id: 'brief',
      kind: 'task.brief',
      text: `Migrate ${nodeId}.`,
      sourceEvent: eventSeq(2),
    }),
    contextSegment({
      id: 'fact-auth-jwt',
      kind: 'fact',
      text: 'finding/auth-uses-jwt: the auth module verifies a JWT in a router guard.',
      sourceEvent: eventSeq(9),
    }),
    contextSegment({
      id: 'artifact-diff',
      kind: 'artifact.handle',
      text: `${handle('diff')} — the diff of the previous attempt`,
      sourceEvent: eventSeq(11),
    }),
    contextSegment({
      id: 'retrieved-guards',
      kind: 'retrieved',
      text: 'src/router/guards.ts lines 1-40, retrieved by the reads resolver.',
      sourceEvent: eventSeq(12),
    }),
    contextSegment({
      id: 'history-summary',
      kind: 'history.summary',
      text: 'Attempt 0 failed the typecheck gate with one blocker.',
      sourceEvent: eventSeq(13),
    }),
    contextSegment({
      id: 'tool-output',
      kind: 'tool.output',
      text: 'pnpm typecheck\nsrc/router/guards.ts(88,5): error TS2345.',
      sourceEvent: eventSeq(14),
    }),
  ]);

  const built = await buildPacket({
    runId: HAPPY_PATH_RUN,
    nodeId,
    attempt,
    builtAtEvent,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec,
      node: { pathScopes: ['src/**'], permission: 'worktree' },
      constraints: [
        { form: 'allow-only', subject: 'write-path', allowed: ['src/**', 'test/**'] },
        { form: 'require', statement: 'Every migrated view keeps its existing route name.' },
        { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env', '~/.aws'] },
      ],
      sourceEvent: eventSeq(4),
    },
    segments,
  });

  // `context.built` records the packet minus each segment's `text` (§9). The
  // totals are the builder's own and are carried, never re-derived — which is
  // the property the projection's own test asserts.
  return {
    ...built.packet,
    segments: built.packet.segments.map(({ text: _text, ...record }) => record),
  };
}

// ── happy-path-12 ────────────────────────────────────────────────────────────

const AGENT_BINARY = {
  path: '/tmp/deflow-happy-path-12/bin/claude',
  version: '2.1.220',
  sha256: bareSha('claude-code'),
};

const usage = (input: number, output: number, source: 'vendor-reported' | 'estimated') => ({
  inputTokens: input,
  outputTokens: output,
  source,
});

const completed = (output: unknown, input: number, out: number, costUsd: number) => ({
  status: 'completed' as const,
  output,
  outputSchemaId: 'DeFlow.finding.v1',
  usage: usage(input, out, 'vendor-reported'),
  costUsd,
  producedFacts: [],
  artifacts: [],
});

const started = (node: string, attempt: number) => ({
  node,
  attempt,
  ikey: `${HAPPY_PATH_RUN}/${node}/${attempt}/0`,
  binary: AGENT_BINARY,
});

const scheduled = (node: string, provider: string, permission: string) => ({
  node,
  provider,
  permission,
});

function verdict(
  gate: string,
  node: string,
  outcome: 'pass' | 'fail' | 'needs-human',
  criteria: readonly { id: string; status: 'satisfied' | 'unsatisfied' | 'unverifiable' }[],
  findings: readonly unknown[],
  summary: string,
) {
  return {
    schemaId: 'DeFlow.verdict.v4',
    outcome,
    gate,
    evaluatedNode: node,
    by: { node: gate, provider: 'deflow', model: 'deterministic-gate' },
    // The run's **real** approved spec hash, not a filler: `reduce()` treats a
    // verdict whose `specHash` is not the contract now in force as *void*
    // (KAR-12.4), so a fixture with a fabricated hash here produces a run whose
    // `/api/runs/:id/gates` is empty however many gates it evaluated — and the
    // criteria board it exists to develop has nothing to render.
    specHash: approvedSpec().specHash,
    criteria: [...criteria],
    findings: [...findings],
    summary,
  };
}

async function happyPathEvents(): Promise<Event[]> {
  const plan = await happyPathPlan();
  const spec = approvedSpec();
  const packetSignup = await packetRecord('impl-signup', 0, 40, spec);
  const packetReview = await packetRecord('review-security', 0, 62, spec);
  const packetLogin = await packetRecord('impl-login', 0, 21, spec);
  // The pinned segment whose digest stops matching. Taken off the packet rather
  // than invented, so the violation names a segment that is really in it.
  const pinnedLost = packetLogin.segments.find((segment) => segment.pinned);
  if (pinnedLost === undefined) throw new Error('a packet with no pinned segment cannot lose one');

  const facts = {
    jwt: factId('auth-uses-jwt'),
    router: factId('router-guard-shape'),
    stale: factId('legacy-shim-needed'),
  };

  const fact = (id: string, key: string, byNode: string, atEvent: number, confidence: string) => ({
    id,
    key,
    kind: key.split('/')[0],
    schemaId: 'DeFlow.finding.v1',
    value: { text: `${key} as observed by ${byNode}` },
    provenance: {
      byNode,
      byProvider: 'claude-code',
      byModel: 'sonnet-4-6',
      fromEvidence: [handle(key)],
      atEvent,
      at: new Date(T0 + atEvent * 1_000).toISOString(),
      confidence,
    },
  });

  return envelopes(HAPPY_PATH_RUN, [
    {
      seq: 1,
      kind: 'run.created',
      payload: {
        spec,
        cwd: '/tmp/deflow-happy-path-12/repo',
        repo: { head: 'a1b2c3d', branch: 'main' },
      },
    },
    { seq: 2, kind: 'run.spec.approved', payload: { specHash: spec.specHash, by: 'ui' } },
    {
      seq: 4,
      kind: 'plan.proposed',
      payload: { version: 1, planHash: plan.planHash, graph: plan, by: 'planner' },
    },
    { seq: 5, kind: 'run.started', payload: { planHash: plan.planHash } },

    // recon → passed, and the fact it wrote is read by two nodes downstream.
    {
      seq: 7,
      kind: 'node.scheduled',
      nodeId: 'recon-auth-surface',
      payload: scheduled('recon-auth-surface', 'claude-code', 'read'),
    },
    {
      seq: 8,
      kind: 'node.started',
      nodeId: 'recon-auth-surface',
      attempt: 0,
      payload: started('recon-auth-surface', 0),
    },
    {
      seq: 9,
      kind: 'fact.written',
      nodeId: 'recon-auth-surface',
      payload: {
        fact: fact(facts.jwt, 'finding/auth-uses-jwt', 'recon-auth-surface', 9, 'verified'),
      },
    },
    {
      seq: 10,
      kind: 'budget.consumed',
      nodeId: 'recon-auth-surface',
      attempt: 0,
      payload: {
        node: 'recon-auth-surface',
        attempt: 0,
        provider: 'claude-code',
        usage: usage(4_200, 810, 'vendor-reported'),
        costUsd: 0.062,
        authMode: 'subscription',
      },
    },
    {
      seq: 11,
      kind: 'node.completed',
      nodeId: 'recon-auth-surface',
      attempt: 0,
      payload: {
        node: 'recon-auth-surface',
        attempt: 0,
        result: completed({ text: 'auth verifies a JWT' }, 4_200, 810, 0.062),
      },
    },

    // plan-migration → passed, reading the fact recon wrote.
    {
      seq: 13,
      kind: 'node.scheduled',
      nodeId: 'plan-migration',
      payload: scheduled('plan-migration', 'claude-code', 'worktree'),
    },
    {
      seq: 14,
      kind: 'node.started',
      nodeId: 'plan-migration',
      attempt: 0,
      payload: started('plan-migration', 0),
    },
    {
      seq: 15,
      kind: 'fact.read',
      nodeId: 'plan-migration',
      payload: { factId: facts.jwt, key: 'finding/auth-uses-jwt', by: 'plan-migration' },
    },
    {
      seq: 16,
      kind: 'fact.written',
      nodeId: 'plan-migration',
      payload: {
        fact: fact(facts.router, 'decision/router-guard-shape', 'plan-migration', 16, 'asserted'),
      },
    },
    {
      seq: 17,
      kind: 'node.completed',
      nodeId: 'plan-migration',
      attempt: 0,
      payload: {
        node: 'plan-migration',
        attempt: 0,
        result: completed({ text: 'five views to migrate' }, 3_100, 640, 0.041),
      },
    },

    // impl-login → failed, permanently: the one node that ends `failed`, and it
    // ends there because a pinned segment did not survive re-injection (F6.6).
    {
      seq: 19,
      kind: 'node.scheduled',
      nodeId: 'impl-login',
      payload: scheduled('impl-login', 'claude-code', 'worktree'),
    },
    {
      seq: 20,
      kind: 'node.started',
      nodeId: 'impl-login',
      attempt: 0,
      payload: started('impl-login', 0),
    },
    {
      seq: 21,
      kind: 'context.built',
      nodeId: 'impl-login',
      attempt: 0,
      payload: { node: 'impl-login', attempt: 0, packet: packetLogin },
    },
    {
      seq: 22,
      kind: 'fact.read',
      nodeId: 'impl-login',
      payload: { factId: facts.router, key: 'decision/router-guard-shape', by: 'impl-login' },
    },
    {
      seq: 23,
      kind: 'pin.integrity_violated',
      nodeId: 'impl-login',
      attempt: 0,
      payload: {
        node: 'impl-login',
        attempt: 0,
        missingDigests: [pinnedLost.contentHash],
        segmentIds: [pinnedLost.id],
      },
    },
    {
      seq: 24,
      kind: 'node.failed',
      nodeId: 'impl-login',
      attempt: 0,
      payload: {
        node: 'impl-login',
        attempt: 0,
        failure: {
          reason: 'safety.pin-integrity-violated',
          class: 'permanent',
          message: 'a pinned constraint segment did not survive re-injection',
          evidence: [handle('impl-login-pin')],
          occurredAtEvent: 23,
          attempt: 0,
        },
      },
    },

    // impl-logout → failed once, retried, passed: two spans, one node.
    {
      seq: 25,
      kind: 'node.scheduled',
      nodeId: 'impl-logout',
      payload: scheduled('impl-logout', 'claude-code', 'worktree'),
    },
    {
      seq: 26,
      kind: 'node.started',
      nodeId: 'impl-logout',
      attempt: 0,
      payload: started('impl-logout', 0),
    },
    {
      seq: 27,
      kind: 'node.failed',
      nodeId: 'impl-logout',
      attempt: 0,
      payload: {
        node: 'impl-logout',
        attempt: 0,
        failure: {
          reason: 'timeout',
          class: 'transient',
          message: 'the turn exceeded its wall-clock budget',
          evidence: [],
          occurredAtEvent: 27,
          attempt: 0,
        },
      },
    },
    {
      seq: 28,
      kind: 'node.retry.scheduled',
      nodeId: 'impl-logout',
      payload: { node: 'impl-logout', nextAttempt: 1, wakeAt: T0 + 30 * MINUTE },
    },
    {
      seq: 29,
      kind: 'node.started',
      nodeId: 'impl-logout',
      attempt: 1,
      ts: T0 + 30 * MINUTE,
      payload: started('impl-logout', 1),
    },
    {
      seq: 30,
      kind: 'node.completed',
      nodeId: 'impl-logout',
      attempt: 1,
      ts: T0 + 34 * MINUTE,
      payload: {
        node: 'impl-logout',
        attempt: 1,
        result: completed({ text: 'logout migrated' }, 2_400, 520, 0.033),
      },
    },

    // impl-profile → blocked by a conflict probe against a node still running.
    {
      seq: 32,
      kind: 'node.scheduled',
      nodeId: 'impl-profile',
      payload: scheduled('impl-profile', 'claude-code', 'worktree'),
    },
    {
      seq: 33,
      kind: 'node.blocked',
      nodeId: 'impl-profile',
      payload: {
        node: 'impl-profile',
        conflictsWith: 'impl-signup',
        branch: 'deflow/impl-profile',
        otherBranch: 'deflow/impl-signup',
        paths: ['src/router/guards.ts'],
      },
    },

    // impl-legacy-shim → abandoned by a patch, never started.
    {
      seq: 35,
      kind: 'node.scheduled',
      nodeId: 'impl-legacy-shim',
      payload: scheduled('impl-legacy-shim', 'claude-code', 'worktree'),
    },

    // impl-signup → running, and never terminated: the open-ended span.
    {
      seq: 38,
      kind: 'node.scheduled',
      nodeId: 'impl-signup',
      payload: scheduled('impl-signup', 'claude-code', 'worktree'),
    },
    {
      seq: 39,
      kind: 'node.started',
      nodeId: 'impl-signup',
      attempt: 0,
      payload: started('impl-signup', 0),
    },
    {
      seq: 40,
      kind: 'context.built',
      nodeId: 'impl-signup',
      attempt: 0,
      payload: { node: 'impl-signup', attempt: 0, packet: packetSignup },
    },
    {
      seq: 41,
      kind: 'node.progress',
      nodeId: 'impl-signup',
      attempt: 0,
      payload: {
        node: 'impl-signup',
        attempt: 0,
        phase: 'editing',
        message: 'rewriting the signup form',
      },
    },
    {
      seq: 42,
      kind: 'budget.consumed',
      nodeId: 'impl-signup',
      attempt: 0,
      payload: {
        node: 'impl-signup',
        attempt: 0,
        provider: 'claude-code',
        usage: usage(9_800, 1_450, 'vendor-reported'),
        costUsd: 0.147,
        authMode: 'subscription',
      },
    },

    // A provider that reports nothing machine-readable: `costUsd` is null, and
    // the projection has to say "unaccounted" rather than "$0.00".
    {
      seq: 43,
      kind: 'budget.consumed',
      nodeId: 'impl-signup',
      attempt: 0,
      payload: {
        node: 'impl-signup',
        attempt: 0,
        provider: 'gemini-cli',
        usage: usage(1_200, 300, 'estimated'),
        costUsd: null,
        authMode: 'subscription',
      },
    },
    {
      seq: 44,
      kind: 'provider.rate_limited',
      payload: {
        provider: 'claude-code',
        resetsAt: T0 + 2 * HOUR,
        raw: { type: 'rate_limit_event', tier: 'five_hour' },
      },
    },

    // The patch that abandons the legacy shim.
    {
      seq: 46,
      kind: 'plan.patch.proposed',
      payload: { patch: abandonPatch(), cause: undefined, basePlanHash: plan.planHash },
    },
    {
      seq: 47,
      kind: 'plan.patched',
      payload: {
        version: 2,
        fromHash: plan.planHash,
        toHash: sha256('happy-v2'),
        patchId: 'p-abandon-shim',
        decision: {
          decision: 'auto',
          by: 'policy',
          rule: 'no-write-escalation',
          at: new Date(T0 + 47_000).toISOString(),
        },
        proposedBy: 'scheduler',
      },
    },

    // The typecheck gate passes; the contract gate cannot tell.
    {
      seq: 50,
      kind: 'node.scheduled',
      nodeId: 'gate-typecheck',
      payload: scheduled('gate-typecheck', 'deflow', 'read'),
    },
    {
      seq: 51,
      kind: 'node.started',
      nodeId: 'gate-typecheck',
      attempt: 0,
      payload: started('gate-typecheck', 0),
    },
    {
      seq: 52,
      kind: 'gate.evaluated',
      nodeId: 'gate-typecheck',
      attempt: 0,
      payload: {
        gate: 'typecheck',
        node: 'impl-signup',
        verdict: verdict(
          'typecheck',
          'impl-signup',
          'pass',
          [{ id: 'unit-tests-pass', status: 'satisfied' }],
          [],
          'typecheck is clean',
        ),
      },
    },
    {
      seq: 53,
      kind: 'node.completed',
      nodeId: 'gate-typecheck',
      attempt: 0,
      payload: {
        node: 'gate-typecheck',
        attempt: 0,
        result: completed({ outcome: 'pass' }, 0, 0, 0),
      },
    },

    {
      seq: 55,
      kind: 'node.scheduled',
      nodeId: 'gate-contract',
      payload: scheduled('gate-contract', 'deflow', 'read'),
    },
    {
      seq: 56,
      kind: 'node.started',
      nodeId: 'gate-contract',
      attempt: 0,
      payload: started('gate-contract', 0),
    },
    // `needs-human` because the gate's own tooling is missing — not a `fail`,
    // and `unverifiable` rather than `unsatisfied` for the criterion it could
    // not judge. Folding either into failure sends work into a repair loop no
    // amount of repair will fix.
    {
      seq: 57,
      kind: 'gate.evaluated',
      nodeId: 'gate-contract',
      attempt: 0,
      payload: {
        gate: 'contract',
        node: 'impl-signup',
        verdict: verdict(
          'contract',
          'impl-signup',
          'needs-human',
          [{ id: 'no-v-model-regression', status: 'unverifiable' }],
          [
            {
              id: 'f-contract-1',
              severity: 'major',
              criterion: 'no-v-model-regression',
              location: {
                file: 'src/api/contract.ts',
                line: 31,
                endLine: 34,
                blobSha: hex('contract-blob', 40),
              },
              message: 'the signup response drops `emailVerified`',
              evidence: [handle('contract-report')],
            },
            {
              id: 'f-contract-2',
              severity: 'minor',
              criterion: 'no-v-model-regression',
              location: {
                file: 'src/api/contract.ts',
                line: 12,
                blobSha: hex('contract-blob', 40),
              },
              message: 'the request type gained an optional field',
              evidence: [],
            },
          ],
          'the contract checker is not installed',
        ),
      },
    },
    {
      seq: 58,
      kind: 'node.completed',
      nodeId: 'gate-contract',
      attempt: 0,
      payload: {
        node: 'gate-contract',
        attempt: 0,
        result: completed({ outcome: 'needs-human' }, 0, 0, 0),
      },
    },

    // review-security is suspended on a human gate for six hours.
    {
      seq: 60,
      kind: 'node.scheduled',
      nodeId: 'review-security',
      payload: scheduled('review-security', 'codex', 'read'),
    },
    {
      seq: 61,
      kind: 'node.started',
      nodeId: 'review-security',
      attempt: 0,
      payload: started('review-security', 0),
    },
    {
      seq: 62,
      kind: 'context.built',
      nodeId: 'review-security',
      attempt: 0,
      payload: { node: 'review-security', attempt: 0, packet: packetReview },
    },
    {
      seq: 63,
      kind: 'budget.consumed',
      nodeId: 'review-security',
      attempt: 0,
      payload: {
        node: 'review-security',
        attempt: 0,
        provider: 'codex',
        usage: usage(6_400, 900, 'estimated'),
        costUsd: 0.081,
        authMode: 'api_key',
      },
    },
    {
      seq: 64,
      kind: 'node.suspended',
      nodeId: 'review-security',
      attempt: 0,
      ts: T0 + 40 * MINUTE,
      payload: { node: 'review-security', until: { kind: 'human' } },
    },
    {
      seq: 65,
      kind: 'human.requested',
      nodeId: 'review-security',
      payload: {
        node: 'review-security',
        prompt: 'The reviewer found an auth change it cannot judge. Proceed?',
        options: [
          { id: 'proceed', label: 'Proceed', effect: 'approve' },
          { id: 'stop', label: 'Stop', effect: 'reject' },
        ],
      },
    },

    // Six hours later the operator answers, and the node resumes.
    {
      seq: 68,
      kind: 'human.responded',
      nodeId: 'review-security',
      ts: T0 + 40 * MINUTE + 6 * HOUR,
      payload: {
        node: 'review-security',
        optionId: 'proceed',
        at: new Date(T0 + 40 * MINUTE + 6 * HOUR).toISOString(),
        by: 'operator',
      },
    },
    {
      seq: 69,
      kind: 'node.started',
      nodeId: 'review-security',
      attempt: 1,
      ts: T0 + 40 * MINUTE + 6 * HOUR + 1_000,
      payload: started('review-security', 1),
    },

    // approve-release is waiting on the operator and has not been answered.
    {
      seq: 71,
      kind: 'node.scheduled',
      nodeId: 'approve-release',
      payload: scheduled('approve-release', 'deflow', 'read'),
    },
    {
      seq: 72,
      kind: 'node.suspended',
      nodeId: 'approve-release',
      ts: T0 + 7 * HOUR,
      payload: { node: 'approve-release', until: { kind: 'human' } },
    },

    // smoke-tests is scheduled and nothing more: `pending`, not `undefined`.
    {
      seq: 74,
      kind: 'node.scheduled',
      nodeId: 'smoke-tests',
      payload: scheduled('smoke-tests', 'deflow', 'worktree'),
    },

    // A ceiling the run PAUSED on — it did not fail.
    {
      seq: 76,
      kind: 'budget.exceeded',
      ts: T0 + 7 * HOUR,
      payload: {
        scope: 'run',
        dimension: 'cost',
        limit: 25,
        actual: 25.4,
        failureClass: 'gate',
        firedBy: 'deflow',
        basis: {
          authMode: 'subscription',
          vendorReported: 24.9,
          estimated: 0.5,
          estimateDriven: false,
          unaccounted: ['gemini-cli'],
        },
      },
    },

    // The fact plan-migration asserted turns out to be wrong, and everything
    // that read it is named.
    {
      seq: 78,
      kind: 'fact.invalidated',
      nodeId: 'review-security',
      payload: {
        factId: facts.router,
        by: 'review-security',
        reason: 'the guard shape changed in the router upgrade',
        taints: ['impl-login', 'impl-signup'],
      },
    },
    {
      seq: 79,
      kind: 'fact.written',
      nodeId: 'review-security',
      payload: {
        fact: {
          ...fact(facts.stale, 'risk/legacy-shim-needed', 'review-security', 79, 'speculative'),
          supersedes: facts.router,
        },
      },
    },
    {
      seq: 80,
      kind: 'fact.read',
      nodeId: 'impl-signup',
      payload: { factId: facts.stale, key: 'risk/legacy-shim-needed', by: 'impl-signup' },
    },
  ]);
}

function abandonPatch() {
  return {
    schemaId: 'DeFlow.planpatch.v1',
    id: 'p-abandon-shim',
    proposedBy: 'scheduler',
    reason: 'the legacy shim is unreachable once the router upgrade lands',
    ops: [
      { op: 'abandon-branch', root: 'impl-legacy-shim', reason: 'unreachable after the upgrade' },
    ],
    policy: {
      estimatedCostDeltaUsd: -1.2,
      estimatedWallClockDeltaMs: -600_000,
      blastRadius: { paths: ['src/legacy/**'], nodeCount: 1 },
      replanDepth: 1,
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  };
}

// ── three-patches ────────────────────────────────────────────────────────────

/**
 * The four versions this run walks, each sealed as a real document.
 *
 * Every one of them is emitted as its own `plan.proposed`, because that is what
 * `applyPatchedPlanVersion` does: *"`plan.patched` carries hashes and no
 * document"*, and the successor's graph reaches the ledger as a proposal in the
 * same transaction. A fixture that wrote only the promotion would have a
 * version rail with one rung and a `…/plans/diff` that 404s — which is exactly
 * the state the scrubber fixture exists to make impossible.
 */
async function threePatchesPlans(): Promise<readonly PlanGraph[]> {
  const recon = agentNode('recon', 'Survey the checkout flow', { permission: 'read' });
  const impl = agentNode('impl-checkout', 'Rewrite the checkout flow', { deps: ['recon'] });
  const review = agentNode('review-checkout', 'Review the checkout rewrite', {
    deps: ['impl-checkout'],
    permission: 'read',
  });

  const v1 = await seal(
    THREE_PATCHES_RUN,
    1,
    null,
    [recon, impl],
    [{ from: 'recon', to: 'impl-checkout', kind: 'control' }],
  );

  // The insert: one node added, one edge added, nothing else moved.
  const v2 = await seal(
    THREE_PATCHES_RUN,
    2,
    v1.planHash,
    [recon, impl, review],
    [
      { from: 'recon', to: 'impl-checkout', kind: 'control' },
      { from: 'impl-checkout', to: 'review-checkout', kind: 'control' },
    ],
  );

  // The split: `impl-checkout` becomes two nodes that name it as their
  // ancestor, which is what lets the scrubber animate a split as a split
  // rather than as a delete and two inserts (F2.5).
  const cart = {
    ...agentNode('impl-checkout-cart', 'Rewrite the cart', { deps: ['recon'] }),
    derivedFrom: ['impl-checkout'],
  };
  const payment = {
    ...agentNode('impl-checkout-payment', 'Rewrite the payment step', { deps: ['recon'] }),
    derivedFrom: ['impl-checkout'],
  };
  const reviewAfterSplit = {
    ...review,
    deps: ['impl-checkout-cart', 'impl-checkout-payment'],
  };
  const v3 = await seal(
    THREE_PATCHES_RUN,
    3,
    v2.planHash,
    [recon, cart, payment, reviewAfterSplit],
    [
      { from: 'recon', to: 'impl-checkout-cart', kind: 'control' },
      { from: 'recon', to: 'impl-checkout-payment', kind: 'control' },
      { from: 'impl-checkout-cart', to: 'review-checkout', kind: 'control' },
      { from: 'impl-checkout-payment', to: 'review-checkout', kind: 'control' },
    ],
  );

  // The reroute: one node's provider replaced, and nothing about the shape of
  // the graph changes — the case a diff that compared node *sets* would miss.
  const reroutedPayment = {
    ...payment,
    provider: { prefer: ['codex'], requires: ['structuredOutput'] },
    model: 'gpt-5-codex',
  };
  const v4 = await seal(
    THREE_PATCHES_RUN,
    4,
    v3.planHash,
    [recon, cart, reroutedPayment, reviewAfterSplit],
    [
      { from: 'recon', to: 'impl-checkout-cart', kind: 'control' },
      { from: 'recon', to: 'impl-checkout-payment', kind: 'control' },
      { from: 'impl-checkout-cart', to: 'review-checkout', kind: 'control' },
      { from: 'impl-checkout-payment', to: 'review-checkout', kind: 'control' },
    ],
  );

  return [v1, v2, v3, v4];
}

const patchPolicy = (depth: number) => ({
  estimatedCostDeltaUsd: 0.8,
  estimatedWallClockDeltaMs: 300_000,
  blastRadius: { paths: ['src/checkout/**'], nodeCount: 1 },
  replanDepth: depth,
  escalatesPermission: null,
  addsWriteCapability: false,
});

async function threePatchesEvents(): Promise<Event[]> {
  const versions = await threePatchesPlans();
  const [plan] = versions;
  if (plan === undefined) throw new Error('threePatchesPlans returned no versions');
  const hashes = versions.map((version) => version.planHash);

  const decision = (
    outcome: 'auto' | 'approved' | 'rejected',
    by: 'policy' | 'human',
    rule: string,
    seq: number,
  ) => ({
    decision: outcome,
    by,
    rule,
    at: new Date(T0 + seq * 1_000).toISOString(),
  });

  const patch = (id: string, reason: string, ops: readonly unknown[], depth: number) => ({
    schemaId: 'DeFlow.planpatch.v1',
    id,
    proposedBy: 'planner',
    reason,
    ops: [...ops],
    policy: patchPolicy(depth),
  });

  const insert = patch(
    'p-insert-review',
    'a security review is required before checkout ships',
    [
      {
        op: 'insert-nodes',
        nodes: [
          agentNode('review-checkout', 'Review the checkout rewrite', {
            deps: ['impl-checkout'],
            permission: 'read',
          }),
        ],
        edges: [{ from: 'impl-checkout', to: 'review-checkout', kind: 'control' }],
      },
    ],
    1,
  );

  const split = patch(
    'p-split-impl',
    'the checkout rewrite is two independent changes',
    [
      {
        op: 'split-node',
        node: 'impl-checkout',
        into: [
          agentNode('impl-checkout-cart', 'Rewrite the cart', { deps: ['recon'] }),
          agentNode('impl-checkout-payment', 'Rewrite the payment step', { deps: ['recon'] }),
        ],
        edges: [
          { from: 'impl-checkout-cart', to: 'review-checkout', kind: 'control' },
          { from: 'impl-checkout-payment', to: 'review-checkout', kind: 'control' },
        ],
      },
    ],
    2,
  );

  const reroute = patch(
    'p-reroute-payment',
    'claude-code is out of quota for the next four hours',
    [
      {
        op: 'replace-provider',
        node: 'impl-checkout-payment',
        provider: 'codex',
        model: 'gpt-5-codex',
      },
    ],
    3,
  );

  const refused = patch(
    'p-widen-scope',
    'the payment step needs to edit the shared money helper',
    [{ op: 'replace-provider', node: 'impl-checkout-cart', provider: 'copilot' }],
    3,
  );

  return envelopes(THREE_PATCHES_RUN, [
    {
      seq: 100,
      kind: 'plan.proposed',
      payload: { version: 1, planHash: plan.planHash, graph: plan, by: 'planner' },
    },
    { seq: 101, kind: 'run.started', payload: { planHash: plan.planHash } },

    { seq: 103, kind: 'plan.patch.proposed', payload: { patch: insert, basePlanHash: hashes[0] } },
    {
      seq: 104,
      kind: 'plan.proposed',
      payload: { version: 2, planHash: hashes[1], graph: versions[1], by: 'planner' },
    },
    {
      seq: 105,
      kind: 'plan.patched',
      payload: {
        version: 2,
        fromHash: hashes[0],
        toHash: hashes[1],
        patchId: insert.id,
        decision: decision('auto', 'policy', 'adds-no-write-capability', 105),
        proposedBy: 'planner',
      },
    },

    { seq: 107, kind: 'plan.patch.proposed', payload: { patch: split, basePlanHash: hashes[1] } },
    {
      seq: 108,
      kind: 'plan.proposed',
      payload: { version: 3, planHash: hashes[2], graph: versions[2], by: 'planner' },
    },
    {
      seq: 109,
      kind: 'plan.patched',
      payload: {
        version: 3,
        fromHash: hashes[1],
        toHash: hashes[2],
        patchId: split.id,
        decision: decision('approved', 'human', 'default', 109),
        proposedBy: 'planner',
      },
    },

    {
      seq: 111,
      kind: 'plan.patch.proposed',
      payload: { patch: reroute, cause: 'quota', basePlanHash: hashes[2] },
    },
    {
      seq: 112,
      kind: 'plan.proposed',
      payload: { version: 4, planHash: hashes[3], graph: versions[3], by: 'planner' },
    },
    {
      seq: 113,
      kind: 'plan.patched',
      payload: {
        version: 4,
        fromHash: hashes[2],
        toHash: hashes[3],
        patchId: reroute.id,
        decision: decision('auto', 'policy', 'quota-reroute-equivalent', 113),
        proposedBy: 'scheduler',
      },
    },

    // The proposal that was refused. The rail records it and the version does
    // not advance: "what was proposed and refused" is a question the scrubber
    // has to be able to answer.
    { seq: 115, kind: 'plan.patch.proposed', payload: { patch: refused, basePlanHash: hashes[3] } },
    {
      seq: 116,
      kind: 'plan.patch.rejected',
      payload: { patchId: refused.id, rule: 'escalates-permission', by: 'policy' },
    },
  ]);
}

// ── stress-400 ───────────────────────────────────────────────────────────────

/**
 * KAR-16.5 AC10 — the wide `map` fan-out, and the fixture KAR-16.6's render
 * budget, ELK layout time and scrubber responsiveness are all measured against.
 *
 * The children are **materialised nodes with real ids**, minted by the
 * production `mapChildId` rather than formatted here: a `map` node's children
 * are ordinary plan nodes (`<mapNodeId>--<itemId>`) precisely so the scheduler,
 * the effect journal and the graph canvas need no special case for them
 * (docs/04-domain-model.md §1.1). Rendering 400 of *those* is the measurement;
 * rendering one map node with a count on it is not, and would let a canvas that
 * collapses fan-outs pass a budget it never paid.
 *
 * The nodes are deliberately lean — no per-node prose beyond what the schema
 * needs — because 400 of anything is a size question: the committed file has to
 * stay something a repository can carry, and the `plan.proposed` payload has to
 * stay under the 256 KiB inline ceiling or a real daemon would have spilled it
 * to the blob store and the fixture would no longer be one file.
 */
export const STRESS_400_RUN = 'run_20260811T120000Z_e3f4a5';

/** AC10's floor is 400 *plan nodes*; the fan-out alone clears it. */
export const STRESS_400_FANOUT = 400;

/** The collection the map fans out over — one legacy view per child. */
const stressItems = (): readonly { readonly path: string }[] =>
  Array.from({ length: STRESS_400_FANOUT }, (_, index) => ({
    path: `src/legacy/views/view-${String(index + 1).padStart(3, '0')}.vue`,
  }));

function stressChild(item: { readonly path: string }, index: number): NodeDocument {
  return {
    id: mapChildId('migrate-views' as NodeId, item, index),
    title: `Migrate ${item.path.slice(item.path.lastIndexOf('/') + 1)}`,
    type: 'agent',
    deps: ['migrate-views'],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: [item.path] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1_000 },
    retry: structuredClone(RETRY),
    budget: { maxCostUsd: 0.5, maxWallClockMs: 120_000 },
    brief: `Migrate ${item.path} to Vue 3.`,
    provider: { prefer: ['claude-code'], requires: ['structuredOutput'] },
    resume: 'native-if-available',
  };
}

async function stress400Plan(): Promise<PlanGraph> {
  const items = stressItems();

  const mapNode: NodeDocument = {
    id: 'migrate-views',
    title: 'Migrate every legacy view',
    type: 'map',
    deps: ['recon-legacy-views'],
    lifecycle: 'active',
    reads: [{ kind: 'fact', key: 'finding/legacy-views' }],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: ['src/legacy/**'] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1_000 },
    retry: structuredClone(RETRY),
    budget: { maxCostUsd: 200, maxWallClockMs: 7_200_000 },
    over: { kind: 'fact', key: 'finding/legacy-views' },
    concurrency: 8,
    body: 'migrate-one-view',
    itemIdFrom: 'value-hash',
  };

  const nodes: NodeDocument[] = [
    agentNode('recon-legacy-views', 'Enumerate the legacy views', {
      permission: 'read',
      writes: [{ kind: 'fact', key: 'finding/legacy-views', schemaId: 'DeFlow.finding.v1' }],
    }),
    mapNode,
    // The body template the children were instantiated from. It stays in the
    // graph and never runs — the children are what run — which is exactly the
    // shape a renderer has to cope with.
    agentNode('migrate-one-view', 'Migrate one legacy view', { deps: ['recon-legacy-views'] }),
    ...items.map((item, index) => stressChild(item, index)),
    gateNode('gate-typecheck', 'The project typechecks', 'typecheck', ['migrate-views']),
  ];

  const edges: EdgeDocument[] = [
    {
      from: 'recon-legacy-views',
      to: 'migrate-views',
      kind: 'data',
      carries: ['finding/legacy-views'],
    },
    { from: 'migrate-views', to: 'gate-typecheck', kind: 'control' },
  ];

  return await seal(STRESS_400_RUN, 1, null, nodes, edges);
}

async function stress400Events(): Promise<Event[]> {
  const plan = await stress400Plan();
  const spec = approvedSpec();
  const items = stressItems();
  const children = items.map((item, index) => String(stressChild(item, index).id));

  const drafts: Draft[] = [
    {
      seq: 1,
      kind: 'run.created',
      payload: {
        spec,
        cwd: '/tmp/deflow-stress-400/repo',
        repo: { head: 'e3f4a5b', branch: 'main' },
      },
    },
    { seq: 2, kind: 'run.spec.approved', payload: { specHash: spec.specHash, by: 'ui' } },
    {
      seq: 4,
      kind: 'plan.proposed',
      payload: { version: 1, planHash: plan.planHash, graph: plan, by: 'planner' },
    },
    { seq: 5, kind: 'run.started', payload: { planHash: plan.planHash } },
    {
      seq: 7,
      kind: 'node.scheduled',
      nodeId: 'recon-legacy-views',
      payload: scheduled('recon-legacy-views', 'claude-code', 'read'),
    },
    {
      seq: 8,
      kind: 'node.started',
      nodeId: 'recon-legacy-views',
      attempt: 0,
      payload: {
        node: 'recon-legacy-views',
        attempt: 0,
        ikey: `${STRESS_400_RUN}/recon-legacy-views/0/0`,
        binary: AGENT_BINARY,
      },
    },
    {
      seq: 9,
      kind: 'fact.written',
      nodeId: 'recon-legacy-views',
      payload: {
        fact: {
          id: factId('legacy-views'),
          key: 'finding/legacy-views',
          kind: 'finding',
          schemaId: 'DeFlow.finding.v1',
          value: { text: `${STRESS_400_FANOUT} legacy views remain on Vue 2` },
          provenance: {
            byNode: 'recon-legacy-views',
            byProvider: 'claude-code',
            byModel: 'sonnet-4-6',
            fromEvidence: [handle('legacy-views')],
            atEvent: 9,
            at: new Date(T0 + 9_000).toISOString(),
            confidence: 'verified',
          },
        },
      },
    },
    {
      seq: 10,
      kind: 'node.completed',
      nodeId: 'recon-legacy-views',
      attempt: 0,
      payload: {
        node: 'recon-legacy-views',
        attempt: 0,
        result: completed({ text: `${STRESS_400_FANOUT} legacy views` }, 3_100, 600, 0.048),
      },
    },
  ];

  // Every child's three lifecycle events, striding `seq` by four so the file
  // carries the holes a shared AUTOINCREMENT really leaves. This is the bulk of
  // the fixture and it is the point: 400 nodes moving through `pending` →
  // `running` → `passed` is what a projection store and a canvas have to keep
  // up with (KAR-16.4, KAR-16.6).
  //
  // The numbers are *allocated* by a counter rather than derived from one
  // another: `test/no-gap-detection.test.ts` bans writing the successor of a
  // `seq` anywhere under `src/` or `scripts/`, and it is right to — a fixture
  // builder that spelled `seq + 1` reads exactly like the gap detector the
  // whole corpus exists to catch.
  let allocated = 11;
  const nextSeq = (): number => {
    allocated += 1;
    return allocated;
  };

  for (const [index, node] of children.entries()) {
    drafts.push(
      {
        seq: nextSeq(),
        kind: 'node.scheduled',
        nodeId: node,
        payload: scheduled(node, 'claude-code', 'worktree'),
      },
      {
        seq: nextSeq(),
        kind: 'node.started',
        nodeId: node,
        attempt: 0,
        payload: {
          node,
          attempt: 0,
          ikey: `${STRESS_400_RUN}/${node}/0/0`,
          binary: AGENT_BINARY,
        },
      },
      {
        seq: nextSeq(),
        kind: 'node.completed',
        nodeId: node,
        attempt: 0,
        payload: {
          node,
          attempt: 0,
          result: completed({ text: `migrated ${items[index]?.path ?? node}` }, 1_800, 420, 0.021),
        },
      },
    );
    // One burned number per node, so the committed sequence has the holes a
    // shared AUTOINCREMENT really leaves.
    allocated += 1;
  }

  drafts.push(
    {
      seq: nextSeq(),
      kind: 'gate.evaluated',
      nodeId: 'gate-typecheck',
      attempt: 0,
      payload: {
        gate: 'typecheck',
        node: 'migrate-views',
        verdict: verdict(
          'typecheck',
          'migrate-views',
          'pass',
          [{ id: 'typecheck-clean', status: 'satisfied' }],
          [],
          `${STRESS_400_FANOUT} migrated views typecheck`,
        ),
      },
    },
    {
      seq: (allocated += 2),
      kind: 'run.completed',
      payload: { outcome: 'succeeded', criteriaSatisfied: ['typecheck-clean'] },
    },
  );

  return envelopes(STRESS_400_RUN, drafts);
}

// ── the writer ───────────────────────────────────────────────────────────────

const README = (name: string, run: string, what: string) => `# \`${name}\`

${what}

**Assembled by \`packages/core/scripts/build-ui-run-fixtures.ts\`, never edited by
hand.** Rebuild it with:

\`\`\`
node packages/core/scripts/build-ui-run-fixtures.ts
\`\`\`

- run: \`${run}\`
- every envelope is written through \`parseEvent\` before it is serialised, so a
  fixture this build cannot read is a failed build rather than a puzzle inside a
  projection
- \`seq\` has holes, because it is one global \`AUTOINCREMENT\` shared with every
  other run in a data directory (docs/11-api-and-realtime.md §4.2)

**This fixture is assembled, not recorded**, and the two are not the same thing.
\`compaction/\` and \`gate-failure-repair/\` are recordings of real runs;
[KAR-16.5](../../../docs/delivery/epics/EPIC-16-ui-foundation.md) owns replacing
this one with a recording too, and cannot start until \`DeFlow run\` (EPIC-18
KAR-18.3) exists. Until then the payload *shapes* here are the production ones —
\`buildPacket\`, \`planHash\`, \`FactSchema\`, \`parseEvent\` — and only the
scenario is authored.

Everything in here is synthetic: a fabricated run id, fabricated node ids, and
paths under \`/tmp\`.
`;

export async function buildUiRunFixtures(dir: string): Promise<void> {
  const fixtures = [
    {
      name: 'happy-path-12',
      run: HAPPY_PATH_RUN,
      events: await happyPathEvents(),
      what:
        'A twelve-node run reaching every one of F10.1’s seven display states —\n' +
        '`pending`, `running`, `blocked`, `passed`, `failed`, `abandoned` and\n' +
        '`awaiting-human` — with context packets carrying all nine `SegmentKind`s,\n' +
        'both token-usage sources, a provider that prices nothing, a six-hour human\n' +
        'suspension, a retry, and a fact that is later invalidated.',
    },
    {
      name: 'three-patches',
      run: THREE_PATCHES_RUN,
      events: await threePatchesEvents(),
      what:
        'A run patched three times — an insert, a split and a provider replace, each\n' +
        'with its own `reason` and `decision` — plus a fourth proposal that was\n' +
        'refused, so the version rail can be asked what was proposed as well as what\n' +
        'was applied.',
    },
    {
      name: 'stress-400',
      run: STRESS_400_RUN,
      events: await stress400Events(),
      what:
        `A wide \`map\` fan-out: ${STRESS_400_FANOUT} materialised child nodes, each with real\n` +
        '`<mapNodeId>--<itemId>` ids minted by `mapChildId`, each moving through\n' +
        '`pending` → `running` → `passed`. This is the fixture\n' +
        '[KAR-16.6](../../../docs/delivery/epics/EPIC-16-ui-foundation.md)’s render\n' +
        'budget, ELK layout time and scrubber responsiveness are measured against, and\n' +
        'the one KAR-16.4’s bounded-memory ring is exercised by.',
    },
  ];

  for (const fixture of fixtures) {
    const target = join(dir, fixture.name);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'events.jsonl'),
      `${fixture.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    writeFileSync(join(target, 'README.md'), README(fixture.name, fixture.run, fixture.what));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await buildUiRunFixtures(process.argv[2] ?? RUN_FIXTURES_DIR);
  process.stdout.write(
    `wrote happy-path-12, three-patches and stress-400 into ${RUN_FIXTURES_DIR}\n`,
  );
}
