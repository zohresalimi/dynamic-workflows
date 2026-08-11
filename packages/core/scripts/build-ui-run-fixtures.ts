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
import { planHash, specHash } from '../src/hash.ts';
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
async function packetRecord(
  nodeId: string,
  attempt: number,
  builtAtEvent: number,
  spec: TaskSpec,
  options: { readonly runId?: string; readonly omit?: readonly string[] } = {},
) {
  const drafts = [
    {
      id: 'brief',
      kind: 'task.brief',
      text: `Migrate ${nodeId}.`,
      sourceEvent: eventSeq(2),
    },
    {
      id: 'fact-auth-jwt',
      kind: 'fact',
      text: 'finding/auth-uses-jwt: the auth module verifies a JWT in a router guard.',
      sourceEvent: eventSeq(9),
    },
    {
      id: 'artifact-diff',
      kind: 'artifact.handle',
      text: `${handle('diff')} — the diff of the previous attempt`,
      sourceEvent: eventSeq(11),
    },
    {
      id: 'retrieved-guards',
      kind: 'retrieved',
      text: 'src/router/guards.ts lines 1-40, retrieved by the reads resolver.',
      sourceEvent: eventSeq(12),
    },
    {
      id: 'history-summary',
      kind: 'history.summary',
      text: 'Attempt 0 failed the typecheck gate with one blocker.',
      sourceEvent: eventSeq(13),
    },
    {
      id: 'tool-output',
      kind: 'tool.output',
      text: 'pnpm typecheck\nsrc/router/guards.ts(88,5): error TS2345.',
      sourceEvent: eventSeq(14),
    },
  ] as const;

  // `omit` is how `repair-attempts` builds a **smaller** first packet than the
  // one the repair loop later hands the same node: attempt 0 has no history
  // summary and no tool output because nothing has happened yet, and attempt 1
  // does. That difference is the whole subject of KAR-17.3's attempt
  // comparison, and it has to come out of *this* builder rather than out of an
  // edited copy — otherwise the comparison is over two packets assembled
  // differently, and it would agree with itself no matter what the code did.
  const omit = options.omit ?? [];
  const segments = await Promise.all(
    drafts.filter((draft) => !omit.includes(draft.id)).map((draft) => contextSegment(draft)),
  );

  const built = await buildPacket({
    runId: options.runId ?? HAPPY_PATH_RUN,
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

    // F4.7's report, and the reason the timeline has a marker for it: the rate
    // limit above stopped the only running node from producing anything, and
    // ten idle minutes later the daemon says so. `run.stalled` is an
    // observation and never a kill — a long build looks identical to a wedged
    // agent from here — so nothing downstream of this event differs because of
    // it, which is exactly why it has to be *visible*.
    {
      seq: 45,
      kind: 'run.stalled',
      ts: T0 + 11 * MINUTE,
      payload: { watermarkSeq: 41, idleMs: 10 * MINUTE, runningNodes: ['impl-signup'] },
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
// ── repair-attempts ──────────────────────────────────────────────────────────

/**
 * KAR-17.3 — one node, three attempts, **a context packet per attempt**.
 *
 * No other fixture in the corpus has two packets for the same node, and without
 * one the node inspector's attempt comparison (AC6, EPIC-17-S13) cannot be
 * asserted against anything: a side-by-side of attempt 1 and attempt 3 that has
 * only ever been shown one packet agrees with itself.
 *
 * The three attempts are shaped to make the two interesting readings visible:
 *
 * - **attempt 1 → attempt 2 changed the context.** The first packet is built
 *   before anything has happened, so it carries no `history.summary` and no
 *   `tool.output`; the repaired second one carries both. That is a repair that
 *   did something, and it is what the diff should say.
 * - **attempt 2 → attempt 3 changed nothing.** The third packet is byte-identical
 *   to the second, segment for segment. *"A repair that produced an identical
 *   packet is a visible, diagnosable no-op"* (EPIC-17-S13) — and it is only
 *   diagnosable if a fixture contains one.
 *
 * The ladder ends on `contract.schema-invalid`, carrying the Ajv errors in the
 * failure's own `detail` and the offending output as an evidence handle, which
 * is AC5's *"shows the Ajv error beside the offending output rather than a
 * generic message"* given something to show. And `probe-oauth-tokens` fails at
 * `adapter.spawn-failed` — under ACP the binary is spawned and handshaken
 * *before* a prompt is ever sent, so that node genuinely never had a packet,
 * which is the honest-emptiness case of AC9.
 */
export const REPAIR_ATTEMPTS_RUN = 'run_20260811T140000Z_c4d5e6';

const REPAIR_BINARY = {
  path: '/tmp/deflow-repair-attempts/bin/claude',
  version: '2.1.220',
  sha256: bareSha('claude-code-repair'),
};

/**
 * The Ajv errors, in Ajv's own `ErrorObject` shape.
 *
 * `NodeFailure.detail` is `Record<string, unknown>` — *"reason-specific and
 * JSON-only"* — and this is what a `contract.schema-invalid` puts in it. Written
 * in the validator's vocabulary (`instancePath`, `schemaPath`, `keyword`,
 * `params`) rather than flattened to a sentence, because the inspector's job is
 * to point at the field that failed and a sentence cannot be pointed with.
 */
const AJV_ERRORS = [
  {
    instancePath: '/findings/0/severity',
    schemaPath: '#/properties/findings/items/properties/severity/enum',
    keyword: 'enum',
    params: { allowedValues: ['blocker', 'major', 'minor', 'nit'] },
    message: 'must be equal to one of the allowed values',
  },
  {
    instancePath: '/summary',
    schemaPath: '#/properties/summary/type',
    keyword: 'type',
    params: { type: 'string' },
    message: 'must be string',
  },
] as const;

async function repairAttemptsPlan(): Promise<PlanGraph> {
  const nodes: NodeDocument[] = [
    agentNode('impl-oauth', 'Move the OAuth callback onto the new router'),
    agentNode('probe-oauth-tokens', 'Probe the token store', { permission: 'read' }),
    gateNode('gate-contract', 'The API contract holds', 'contract', ['impl-oauth']),
  ];

  const edges: EdgeDocument[] = [{ from: 'impl-oauth', to: 'gate-contract', kind: 'control' }];

  return await seal(REPAIR_ATTEMPTS_RUN, 1, null, nodes, edges);
}

async function repairAttemptsEvents(): Promise<Event[]> {
  const plan = await repairAttemptsPlan();
  const spec = approvedSpec();
  const run = REPAIR_ATTEMPTS_RUN;

  // Attempt 0 is built before anything has happened to summarise; attempts 1
  // and 2 are built from the same six drafts and are therefore identical.
  const first = await packetRecord('impl-oauth', 0, 9, spec, {
    runId: run,
    omit: ['history-summary', 'tool-output'],
  });
  const second = await packetRecord('impl-oauth', 1, 16, spec, { runId: run });
  const third = await packetRecord('impl-oauth', 2, 23, spec, { runId: run });

  const startedOn = (node: string, attempt: number) => ({
    node,
    attempt,
    ikey: `${run}/${node}/${attempt}/0`,
    binary: REPAIR_BINARY,
  });

  const spent = (attempt: number, input: number, output: number, costUsd: number) => ({
    node: 'impl-oauth',
    attempt,
    provider: 'claude-code',
    usage: usage(input, output, 'vendor-reported'),
    costUsd,
    authMode: 'subscription',
  });

  return envelopes(run, [
    {
      seq: 1,
      kind: 'run.created',
      payload: {
        spec,
        cwd: '/tmp/deflow-repair-attempts/repo',
        repo: { head: 'c4d5e6f', branch: 'main' },
      },
    },
    { seq: 2, kind: 'run.spec.approved', payload: { specHash: spec.specHash, by: 'ui' } },
    {
      seq: 4,
      kind: 'plan.proposed',
      payload: { version: 1, planHash: plan.planHash, graph: plan, by: 'planner' },
    },
    { seq: 5, kind: 'run.started', payload: { planHash: plan.planHash } },

    // ── attempt 0: a packet with no history, and a transient timeout ──────────
    {
      seq: 7,
      kind: 'node.scheduled',
      nodeId: 'impl-oauth',
      payload: scheduled('impl-oauth', 'claude-code', 'worktree'),
    },
    {
      seq: 8,
      kind: 'node.started',
      nodeId: 'impl-oauth',
      attempt: 0,
      payload: startedOn('impl-oauth', 0),
    },
    {
      seq: 9,
      kind: 'context.built',
      nodeId: 'impl-oauth',
      attempt: 0,
      payload: { node: 'impl-oauth', attempt: 0, packet: first },
    },
    {
      seq: 11,
      kind: 'budget.consumed',
      nodeId: 'impl-oauth',
      attempt: 0,
      payload: spent(0, 5_100, 640, 0.084),
    },
    {
      seq: 12,
      kind: 'node.failed',
      nodeId: 'impl-oauth',
      attempt: 0,
      payload: {
        node: 'impl-oauth',
        attempt: 0,
        failure: {
          reason: 'timeout',
          class: 'transient',
          message: 'the turn exceeded its wall-clock budget',
          evidence: [],
          occurredAtEvent: 12,
          attempt: 0,
        },
      },
    },
    {
      seq: 13,
      kind: 'node.retry.scheduled',
      nodeId: 'impl-oauth',
      payload: { node: 'impl-oauth', nextAttempt: 1, wakeAt: T0 + 5 * HOUR + MINUTE },
    },

    // ── attempt 1: the repaired packet, and a non-zero exit ───────────────────
    {
      seq: 15,
      kind: 'node.started',
      nodeId: 'impl-oauth',
      attempt: 1,
      payload: startedOn('impl-oauth', 1),
    },
    {
      seq: 16,
      kind: 'context.built',
      nodeId: 'impl-oauth',
      attempt: 1,
      payload: { node: 'impl-oauth', attempt: 1, packet: second },
    },
    {
      seq: 18,
      kind: 'budget.consumed',
      nodeId: 'impl-oauth',
      attempt: 1,
      payload: spent(1, 6_400, 910, 0.091),
    },
    {
      seq: 19,
      kind: 'node.failed',
      nodeId: 'impl-oauth',
      attempt: 1,
      payload: {
        node: 'impl-oauth',
        attempt: 1,
        failure: {
          reason: 'agent.nonzero-exit',
          class: 'transient',
          message: 'the CLI exited 2 after writing a partial patch',
          detail: { exitCode: 2 },
          evidence: [handle('oauth-attempt-1-stdout')],
          occurredAtEvent: 19,
          attempt: 1,
        },
      },
    },
    {
      seq: 20,
      kind: 'node.retry.scheduled',
      nodeId: 'impl-oauth',
      payload: { node: 'impl-oauth', nextAttempt: 2, wakeAt: T0 + 5 * HOUR + 2 * MINUTE },
    },

    // ── attempt 2: the same packet again — the no-op repair — and the end ─────
    {
      seq: 22,
      kind: 'node.started',
      nodeId: 'impl-oauth',
      attempt: 2,
      payload: startedOn('impl-oauth', 2),
    },
    {
      seq: 23,
      kind: 'context.built',
      nodeId: 'impl-oauth',
      attempt: 2,
      payload: { node: 'impl-oauth', attempt: 2, packet: third },
    },
    {
      seq: 25,
      kind: 'budget.consumed',
      nodeId: 'impl-oauth',
      attempt: 2,
      payload: spent(2, 6_400, 880, 0.096),
    },
    {
      seq: 26,
      kind: 'node.failed',
      nodeId: 'impl-oauth',
      attempt: 2,
      payload: {
        node: 'impl-oauth',
        attempt: 2,
        failure: {
          reason: 'contract.schema-invalid',
          class: 'permanent',
          message: 'the returned object does not satisfy DeFlow.verdict.v4',
          detail: { schemaId: 'DeFlow.verdict.v4', ajv: structuredClone(AJV_ERRORS) },
          evidence: [handle('oauth-attempt-2-output')],
          occurredAtEvent: 26,
          attempt: 2,
        },
      },
    },

    // ── a node that never had a packet at all ────────────────────────────────
    {
      seq: 28,
      kind: 'node.scheduled',
      nodeId: 'probe-oauth-tokens',
      payload: scheduled('probe-oauth-tokens', 'gemini-cli', 'read'),
    },
    {
      seq: 29,
      kind: 'node.started',
      nodeId: 'probe-oauth-tokens',
      attempt: 0,
      payload: {
        node: 'probe-oauth-tokens',
        attempt: 0,
        ikey: `${run}/probe-oauth-tokens/0/0`,
        binary: {
          path: '/tmp/deflow-repair-attempts/bin/gemini',
          version: '0.9.4',
          sha256: bareSha('gemini-cli-repair'),
        },
      },
    },
    {
      seq: 30,
      kind: 'node.failed',
      nodeId: 'probe-oauth-tokens',
      attempt: 0,
      payload: {
        node: 'probe-oauth-tokens',
        attempt: 0,
        failure: {
          reason: 'adapter.spawn-failed',
          class: 'permanent',
          message: 'spawn /tmp/deflow-repair-attempts/bin/gemini ENOENT',
          detail: { errno: -2, code: 'ENOENT' },
          evidence: [handle('gemini-spawn-stderr')],
          occurredAtEvent: 30,
          attempt: 0,
        },
      },
    },
  ]);
}

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

// ── five-minute-diagnosis ────────────────────────────────────────────────────

/**
 * EPIC-17-S35 — the run the five-minute diagnosis is measured over.
 *
 * The scenario is the epic's Definition of Done and it is written as one
 * continuous journey: *"a four-hour design-system migration produced a bad
 * diff"*, diagnosed in six stops — plan graph, criteria board, diff line, node
 * inspector, context budget, plan scrubber — with a stopwatch running. It needs
 * **one run that answers all six questions**, and no other fixture in the
 * corpus does:
 *
 * - `gate-failure-repair` has a failing verdict with a located finding, and
 *   never built a context packet, so stops four and five are empty;
 * - `repair-attempts` has three packets for one node, and no gate ever spoke,
 *   so stops two and three are empty;
 * - `compaction` is three events with no `run.created` at all — no plan, no
 *   criteria, nothing to orient on.
 *
 * So this one carries the whole chain, and the chain is the point: every stop
 * is a *fact the next stop needs*, which is what makes the walk a diagnosis
 * rather than six independent smoke tests.
 *
 * ```
 *   n-recon writes decision/import-policy          (confidence: speculative)
 *     → n-impl-3's attempt-0 packet carries it as segment `fact-import-policy`
 *       → compaction at `exact` fidelity drops that segment, keeps every pin
 *         → attempts 1 and 2 are built without it
 *           → the import-boundary gate fails AC-3 with a blocker at
 *             packages/ui/src/Button.vue:42
 * ```
 *
 * The honest conclusion the scenario asks the views to make available: the
 * constraint that was dropped was a **fact**, not a pinned constraint —
 * `pinnedKept` proves the pinned spec survived — so this is a plan defect in
 * the node's `reads` declaration and not a pinning failure.
 *
 * ## Two places this departs from the scenario's prose, on purpose
 *
 * - **`confidence` is `speculative`, not `0.6`.** `FactSchema.provenance.confidence`
 *   is a three-value enum (`asserted | verified | speculative`), not a number;
 *   a fixture cannot record 0.6 and the inspector cannot render it. The flow
 *   file is amended to match the domain rather than the domain bent to match
 *   the flow file.
 * - **The re-route is v3, not v4.** The scenario asks the scrubber for the
 *   version that introduced the node and then for *"the next version's"*
 *   provider re-route, so the two are adjacent by construction: v2 splits,
 *   v3 re-routes, v4 abandons the legacy branch.
 *
 * ## The twenty-two nodes
 *
 * The count the scenario states — 18 passed, 1 failed, 2 abandoned, 1
 * awaiting-human — is a count of the *projection*, not of any single plan
 * document. v1 holds nineteen nodes; v2's `split-node` adds three and abandons
 * the node it split (that is what `split-node` means to the plan projection,
 * not a delete); v4's `abandon-branch` abandons the legacy shim. Twenty-two
 * nodes, and the two abandoned ones are abandoned for two different reasons,
 * which is the distinction the graph has to be able to draw.
 */
export const DIAGNOSIS_RUN = 'run_20260811T160000Z_d7e8f9';

/** The gate that speaks to AC-3, and the criterion it refuses. */
const IMPORT_BOUNDARY_GATE = 'import-boundary';
const AC3 = 'ac-3';

/** Where the blocker is, verbatim from the scenario. */
const BUTTON_FILE = 'packages/ui/src/Button.vue';
const BUTTON_LINE = 42;

/** The fact the packet loses, and the node that wrote it. */
const POLICY_KEY = 'decision/import-policy';
const POLICY_SEGMENT = 'fact-import-policy';

const DIAGNOSIS_SPEC_FIXTURE = fileURLToPath(
  new URL('../test/fixtures/specs/design-system-migration.json', import.meta.url),
);

const DIAGNOSIS_BINARY = {
  path: '/tmp/deflow-five-minute-diagnosis/bin/claude',
  version: '2.1.220',
  sha256: bareSha('claude-code-diagnosis'),
};

const DIAGNOSIS_CWD = '/tmp/deflow-five-minute-diagnosis/repo';

/**
 * The spec, approved, with a **computed** `specHash`.
 *
 * Computed rather than a literal because every verdict below cites it, and
 * `reduce()` treats a verdict whose `specHash` is not the contract in force as
 * *void* (KAR-12.4) — a fixture with a hand-typed hash produces a criteria
 * board that is silently empty, which is precisely the stop this fixture exists
 * to put something on.
 */
async function diagnosisSpec(): Promise<TaskSpec> {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(DIAGNOSIS_SPEC_FIXTURE, 'utf8'));
  draft.approvedBy = { at: '2026-08-11T15:55:00Z', via: 'ui' };
  return TaskSpecSchema.parse({ ...draft, specHash: await specHash(draft) });
}

/** The migration nodes, whose write scope is the package the finding is in. */
function migrationNode(id: string, title: string, options: AgentOptions = {}): NodeDocument {
  return {
    ...agentNode(id, title, options),
    pathScopes: { write: ['packages/ui/**', 'packages/app/**'], read: ['packages/**'] },
  };
}

/** The three nodes `n-impl-migrate` is split into, as v2's patch names them. */
function splitInto(): NodeDocument[] {
  return [
    {
      ...migrationNode('n-impl-3', 'Migrate the Button surface', {
        deps: ['n-plan'],
        // The `reads` declaration the diagnosis indicts: the node asks for the
        // spec goal and never names the fact it cannot work without, so the
        // fact is compactable and compaction is within its rights to drop it.
        writes: [],
      }),
      derivedFrom: ['n-impl-migrate'],
    },
    {
      ...migrationNode('n-impl-4', 'Migrate the Dialog surface', { deps: ['n-plan'] }),
      derivedFrom: ['n-impl-migrate'],
    },
    {
      ...migrationNode('n-impl-5', 'Migrate the Table surface', { deps: ['n-plan'] }),
      derivedFrom: ['n-impl-migrate'],
    },
  ];
}

/** The nodes that never change across the four versions. */
function diagnosisFixedNodes(): NodeDocument[] {
  return [
    migrationNode('n-recon', 'Survey the component surface', {
      permission: 'read',
      writes: [{ kind: 'fact', key: POLICY_KEY, schemaId: 'DeFlow.finding.v1' }],
    }),
    migrationNode('n-plan', 'Plan the migration', { deps: ['n-recon'] }),
    migrationNode('n-impl-1', 'Migrate the Badge surface', { deps: ['n-plan'] }),
    migrationNode('n-impl-2', 'Migrate the Card surface', { deps: ['n-plan'] }),
    ...['6', '7', '8', '9', '10'].map((index) =>
      migrationNode(`n-impl-${index}`, `Migrate product surface ${index}`, { deps: ['n-plan'] }),
    ),
    gateNode('n-gate-typecheck', 'The packages typecheck', 'typecheck', ['n-impl-1']),
    gateNode('n-gate-lint', 'The packages lint', 'lint', ['n-impl-1']),
    gateNode('n-gate-tests', 'The unit tests pass', 'tests', ['n-impl-1']),
    gateNode('n-gate-import-boundary', 'No internal imports', IMPORT_BOUNDARY_GATE, ['n-impl-1']),
    migrationNode('n-docs', 'Update the component docs', { deps: ['n-gate-typecheck'] }),
    migrationNode('n-changelog', 'Write the changelog', { deps: ['n-docs'] }),
    migrationNode('n-release-notes', 'Draft the release notes', { deps: ['n-changelog'] }),
    humanNode('n-approve', 'Operator approves the migration', ['n-release-notes']),
    // A branch of its own, with nothing downstream: v4's `abandon-branch`
    // abandons exactly this node and the graph has to show that it stopped
    // being work rather than that it failed.
    migrationNode('n-legacy-shim', 'Keep the Vue 2 shim alive', { deps: ['n-plan'] }),
  ];
}

function diagnosisEdges(implIds: readonly string[]): EdgeDocument[] {
  return [
    // The one data edge: the fact that the whole diagnosis turns on, drawn as
    // what crosses the edge rather than as an arrow.
    { from: 'n-recon', to: 'n-plan', kind: 'data', carries: [POLICY_KEY] },
    ...implIds.map((to): EdgeDocument => ({ from: 'n-plan', to, kind: 'control' })),
    { from: 'n-plan', to: 'n-legacy-shim', kind: 'control' },
    ...['n-gate-typecheck', 'n-gate-lint', 'n-gate-tests', 'n-gate-import-boundary'].map(
      (to): EdgeDocument => ({ from: 'n-impl-1', to, kind: 'control' }),
    ),
    { from: 'n-gate-typecheck', to: 'n-docs', kind: 'control' },
    { from: 'n-docs', to: 'n-changelog', kind: 'control' },
    { from: 'n-changelog', to: 'n-release-notes', kind: 'control' },
    { from: 'n-release-notes', to: 'n-approve', kind: 'control' },
  ];
}

/** v1 → v4: nineteen nodes, then the split, then the re-route, then the abandon. */
async function diagnosisPlans(): Promise<readonly PlanGraph[]> {
  const migrate = migrationNode('n-impl-migrate', 'Migrate the component surfaces', {
    deps: ['n-plan'],
  });
  const fixed = diagnosisFixedNodes();
  const split = splitInto();

  const v1 = await seal(
    DIAGNOSIS_RUN,
    1,
    null,
    [...fixed, migrate],
    diagnosisEdges([
      'n-impl-1',
      'n-impl-2',
      'n-impl-migrate',
      ...['6', '7', '8', '9', '10'].map((index) => `n-impl-${index}`),
    ]),
  );

  const afterSplit = [
    'n-impl-1',
    'n-impl-2',
    'n-impl-3',
    'n-impl-4',
    'n-impl-5',
    'n-impl-6',
    'n-impl-7',
    'n-impl-8',
    'n-impl-9',
    'n-impl-10',
  ];
  const v2 = await seal(
    DIAGNOSIS_RUN,
    2,
    v1.planHash,
    [...fixed, ...split],
    diagnosisEdges(afterSplit),
  );

  // The re-route: one node's provider replaced and nothing about the shape of
  // the graph moved — which is exactly the change the operator is asking the
  // scrubber about at 3:10.
  const rerouted = split.map((node) =>
    node.id === 'n-impl-3'
      ? {
          ...node,
          provider: { prefer: ['codex'], requires: ['structuredOutput'] },
          model: 'gpt-5-codex',
        }
      : node,
  );
  const v3 = await seal(
    DIAGNOSIS_RUN,
    3,
    v2.planHash,
    [...fixed, ...rerouted],
    diagnosisEdges(afterSplit),
  );

  const v4 = await seal(
    DIAGNOSIS_RUN,
    4,
    v3.planHash,
    [
      ...fixed.map((node) =>
        node.id === 'n-legacy-shim' ? { ...node, lifecycle: 'abandoned' } : node,
      ),
      ...rerouted,
    ],
    diagnosisEdges(afterSplit),
  );

  return [v1, v2, v3, v4];
}

/**
 * `n-impl-3`'s packet for one attempt.
 *
 * `withPolicy` is the whole fixture in one boolean: attempt 0 is built with the
 * segment carrying `decision/import-policy`, and attempts 1 and 2 are built
 * without it because the compaction between them dropped it. The two packets
 * come out of the **same builder** rather than out of an edited copy, so the
 * difference the inspector's attempt comparison reports is a difference the
 * production `buildPacket` really produces.
 */
async function diagnosisPacket(
  spec: TaskSpec,
  attempt: number,
  builtAtEvent: number,
  withPolicy: boolean,
) {
  const drafts = [
    {
      id: 'brief',
      kind: 'task.brief' as const,
      text: 'Migrate the Button surface onto the new design system.',
      sourceEvent: eventSeq(2),
    },
    ...(withPolicy
      ? [
          {
            id: POLICY_SEGMENT,
            kind: 'fact' as const,
            text: `${POLICY_KEY}: the internal namespace is private; import from the package root.`,
            sourceEvent: eventSeq(12),
          },
        ]
      : []),
    {
      id: 'retrieved-button',
      kind: 'retrieved' as const,
      text: 'packages/ui/src/Button.vue lines 1-60, retrieved by the reads resolver.',
      sourceEvent: eventSeq(14),
    },
    {
      id: 'artifact-tokens',
      kind: 'artifact.handle' as const,
      text: `${handle('token-map')} — the token map produced by recon`,
      sourceEvent: eventSeq(16),
    },
  ];

  const segments = await Promise.all(drafts.map((draft) => contextSegment(draft)));
  const built = await buildPacket({
    runId: DIAGNOSIS_RUN,
    nodeId: 'n-impl-3',
    attempt,
    builtAtEvent,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec,
      node: { pathScopes: ['packages/ui/**'], permission: 'worktree' },
      constraints: [
        { form: 'allow-only', subject: 'write-path', allowed: ['packages/ui/**'] },
        { form: 'require', statement: 'Every migrated component keeps its public props.' },
      ],
      sourceEvent: eventSeq(4),
    },
    segments,
  });

  return {
    ...built.packet,
    segments: built.packet.segments.map(({ text: _text, ...record }) => record),
  };
}

async function diagnosisEvents(): Promise<Event[]> {
  const versions = await diagnosisPlans();
  const [v1] = versions;
  if (v1 === undefined) throw new Error('diagnosisPlans returned no versions');
  const hashes = versions.map((version) => version.planHash);
  const spec = await diagnosisSpec();

  const withPolicy = await diagnosisPacket(spec, 0, 60, true);
  const withoutPolicy1 = await diagnosisPacket(spec, 1, 72, false);
  const withoutPolicy2 = await diagnosisPacket(spec, 2, 82, false);
  const droppedSegment = withPolicy.segments.find((segment) => segment.id === POLICY_SEGMENT);
  if (droppedSegment === undefined) {
    throw new Error('attempt 0’s packet has no import-policy segment to drop');
  }

  const policyFactId = factId(POLICY_KEY);

  const startedOn = (node: string, attempt: number) => ({
    node,
    attempt,
    ikey: `${DIAGNOSIS_RUN}/${node}/${attempt}/0`,
    binary: DIAGNOSIS_BINARY,
  });

  const spent = (node: string, attempt: number, costUsd: number, provider = 'claude-code') => ({
    node,
    attempt,
    provider,
    usage: usage(7_200, 1_100, 'vendor-reported'),
    costUsd,
    authMode: 'subscription',
  });

  const diagnosisVerdict = (
    gate: string,
    node: string,
    outcome: 'pass' | 'fail',
    criteria: readonly { id: string; status: 'satisfied' | 'unsatisfied' | 'unverifiable' }[],
    findings: readonly unknown[],
    summary: string,
  ) => ({
    schemaId: 'DeFlow.verdict.v4',
    outcome,
    gate,
    evaluatedNode: node,
    by: { node: gate, provider: 'deflow', model: 'deterministic-gate' },
    specHash: spec.specHash,
    criteria: [...criteria],
    findings: [...findings],
    summary,
  });

  const drafts: Draft[] = [];
  let seq = 0;
  const at = (step = 2): number => (seq += step);

  /** One node that ran once and passed — the eleven that are not the story. */
  const passed = (node: string, provider: string, costUsd: number): void => {
    drafts.push(
      {
        seq: at(),
        kind: 'node.scheduled',
        nodeId: node,
        payload: scheduled(node, provider, 'worktree'),
      },
      { seq: at(), kind: 'node.started', nodeId: node, attempt: 0, payload: startedOn(node, 0) },
      {
        seq: at(),
        kind: 'budget.consumed',
        nodeId: node,
        attempt: 0,
        payload: spent(node, 0, costUsd, provider),
      },
      {
        seq: at(),
        kind: 'node.completed',
        nodeId: node,
        attempt: 0,
        payload: {
          node,
          attempt: 0,
          result: completed({ text: `${node} done` }, 7_200, 1_100, costUsd),
        },
      },
    );
  };

  /** A gate node that ran and returned `verdict`. */
  const gateRan = (node: string, gate: string, verdictDoc: unknown): void => {
    drafts.push(
      {
        seq: at(),
        kind: 'node.scheduled',
        nodeId: node,
        payload: scheduled(node, 'deflow', 'read'),
      },
      { seq: at(), kind: 'node.started', nodeId: node, attempt: 0, payload: startedOn(node, 0) },
      {
        seq: at(),
        kind: 'gate.evaluated',
        nodeId: node,
        attempt: 0,
        payload: { gate, node: 'n-impl-3', verdict: verdictDoc },
      },
      {
        seq: at(),
        kind: 'node.completed',
        nodeId: node,
        attempt: 0,
        payload: { node, attempt: 0, result: completed({ outcome: 'evaluated' }, 0, 0, 0) },
      },
    );
  };

  const patch = (id: string, reason: string, ops: readonly unknown[], depth: number) => ({
    schemaId: 'DeFlow.planpatch.v1',
    id,
    proposedBy: 'planner',
    reason,
    ops: [...ops],
    policy: {
      estimatedCostDeltaUsd: 1.2,
      estimatedWallClockDeltaMs: 600_000,
      blastRadius: { paths: ['packages/ui/**'], nodeCount: 3 },
      replanDepth: depth,
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  });

  const decision = (outcome: 'auto' | 'approved', by: 'policy' | 'human', rule: string) => ({
    decision: outcome,
    by,
    rule,
    at: new Date(T0 + 6 * HOUR).toISOString(),
  });

  const splitPatch = patch(
    'p-split-migration',
    'Recon found 3 additional packages; splitting the migration node',
    [{ op: 'split-node', node: 'n-impl-migrate', into: splitInto(), edges: [] }],
    1,
  );
  const reroutePatch = patch(
    'p-reroute-impl-3',
    'claude-code is out of quota; re-routing the Button surface to codex',
    [{ op: 'replace-provider', node: 'n-impl-3', provider: 'codex', model: 'gpt-5-codex' }],
    2,
  );
  const abandonPatchDoc = patch(
    'p-abandon-legacy-shim',
    'the Vue 2 shim has no consumers left; abandoning the branch',
    [{ op: 'abandon-branch', root: 'n-legacy-shim', reason: 'no consumers left' }],
    3,
  );

  // ── the run opens, and recon writes the fact everything turns on ───────────
  drafts.push(
    {
      seq: at(),
      kind: 'run.created',
      payload: { spec, cwd: DIAGNOSIS_CWD, repo: { head: 'd7e8f9a', branch: 'main' } },
    },
    { seq: at(), kind: 'run.spec.approved', payload: { specHash: spec.specHash, by: 'ui' } },
    {
      seq: at(),
      kind: 'plan.proposed',
      payload: { version: 1, planHash: hashes[0], graph: v1, by: 'planner' },
    },
    { seq: at(), kind: 'run.started', payload: { planHash: hashes[0] } },
  );

  passed('n-recon', 'claude-code', 0.07);
  drafts.push({
    seq: at(),
    kind: 'fact.written',
    nodeId: 'n-recon',
    payload: {
      fact: {
        id: policyFactId,
        key: POLICY_KEY,
        kind: 'decision',
        schemaId: 'DeFlow.finding.v1',
        value: { text: 'the internal namespace is private; import from the package root' },
        provenance: {
          byNode: 'n-recon',
          byProvider: 'claude-code',
          byModel: 'sonnet-4-6',
          fromEvidence: [handle('import-policy-evidence')],
          atEvent: seq,
          at: new Date(T0 + seq * 1_000).toISOString(),
          // The scenario says "0.6". `ConfidenceSchema` is an enum, so the
          // fixture records the band 0.6 falls in and the flow file says so.
          confidence: 'speculative',
        },
      },
    },
  });
  passed('n-plan', 'claude-code', 0.05);

  // ── v2: the split that created the failed node, then v3's re-route ─────────
  drafts.push(
    {
      seq: at(),
      kind: 'plan.patch.proposed',
      payload: { patch: splitPatch, basePlanHash: hashes[0] },
    },
    {
      seq: at(),
      kind: 'plan.proposed',
      payload: { version: 2, planHash: hashes[1], graph: versions[1], by: 'planner' },
    },
    {
      seq: at(),
      kind: 'plan.patched',
      payload: {
        version: 2,
        fromHash: hashes[0],
        toHash: hashes[1],
        patchId: splitPatch.id,
        decision: decision('auto', 'policy', 'adds-no-write-capability'),
        proposedBy: 'planner',
      },
    },
    {
      seq: at(),
      kind: 'plan.patch.proposed',
      payload: { patch: reroutePatch, cause: 'quota', basePlanHash: hashes[1] },
    },
    {
      seq: at(),
      kind: 'plan.proposed',
      payload: { version: 3, planHash: hashes[2], graph: versions[2], by: 'planner' },
    },
    {
      seq: at(),
      kind: 'plan.patched',
      payload: {
        version: 3,
        fromHash: hashes[1],
        toHash: hashes[2],
        patchId: reroutePatch.id,
        decision: decision('auto', 'policy', 'quota-reroute-equivalent'),
        proposedBy: 'scheduler',
      },
    },
  );

  passed('n-impl-1', 'claude-code', 0.06);
  passed('n-impl-2', 'claude-code', 0.06);

  // ── n-impl-3: three attempts, and the compaction between the first two ─────
  drafts.push(
    {
      seq: at(),
      kind: 'node.scheduled',
      nodeId: 'n-impl-3',
      payload: scheduled('n-impl-3', 'codex', 'worktree'),
    },
    {
      seq: at(),
      kind: 'node.started',
      nodeId: 'n-impl-3',
      attempt: 0,
      payload: startedOn('n-impl-3', 0),
    },
    {
      seq: at(),
      kind: 'fact.read',
      nodeId: 'n-impl-3',
      payload: { factId: policyFactId, key: POLICY_KEY, by: 'n-impl-3' },
    },
    {
      seq: at(),
      kind: 'context.built',
      nodeId: 'n-impl-3',
      attempt: 0,
      payload: { node: 'n-impl-3', attempt: 0, packet: withPolicy },
    },
    {
      seq: at(),
      kind: 'budget.consumed',
      nodeId: 'n-impl-3',
      attempt: 0,
      payload: spent('n-impl-3', 0, 1.42, 'codex'),
    },
    {
      seq: at(),
      kind: 'node.failed',
      nodeId: 'n-impl-3',
      attempt: 0,
      payload: {
        node: 'n-impl-3',
        attempt: 0,
        failure: {
          reason: 'gate.failed',
          class: 'transient',
          message: 'the import-boundary gate refused the change',
          evidence: [handle('impl-3-attempt-0')],
          occurredAtEvent: seq,
          attempt: 0,
        },
      },
    },
    {
      seq: at(),
      kind: 'node.retry.scheduled',
      nodeId: 'n-impl-3',
      payload: { node: 'n-impl-3', nextAttempt: 1, wakeAt: T0 + 7 * HOUR },
    },
    // The event the whole diagnosis converges on. `exact` fidelity, every pin
    // kept, and the one thing dropped is the fact segment.
    {
      seq: at(),
      kind: 'context.compacted',
      nodeId: 'n-impl-3',
      attempt: 0,
      payload: {
        node: 'n-impl-3',
        scope: 'DeFlow.packet',
        trigger: 'threshold',
        fidelity: 'exact',
        before: withPolicy.totals.tokens,
        after: withoutPolicy1.totals.tokens,
        droppedSegments: [POLICY_SEGMENT],
        demotedToHandles: [],
        pinnedKept: withPolicy.pinnedDigests,
        originalHandle: handle('impl-3-packet-before-compaction'),
      },
    },
    {
      seq: at(),
      kind: 'node.started',
      nodeId: 'n-impl-3',
      attempt: 1,
      payload: startedOn('n-impl-3', 1),
    },
    {
      seq: at(),
      kind: 'context.built',
      nodeId: 'n-impl-3',
      attempt: 1,
      payload: { node: 'n-impl-3', attempt: 1, packet: withoutPolicy1 },
    },
    {
      seq: at(),
      kind: 'budget.consumed',
      nodeId: 'n-impl-3',
      attempt: 1,
      payload: spent('n-impl-3', 1, 1.61, 'codex'),
    },
    {
      seq: at(),
      kind: 'node.failed',
      nodeId: 'n-impl-3',
      attempt: 1,
      payload: {
        node: 'n-impl-3',
        attempt: 1,
        failure: {
          reason: 'gate.failed',
          class: 'transient',
          message: 'the import-boundary gate refused the change again',
          evidence: [handle('impl-3-attempt-1')],
          occurredAtEvent: seq,
          attempt: 1,
        },
      },
    },
    {
      seq: at(),
      kind: 'node.retry.scheduled',
      nodeId: 'n-impl-3',
      payload: { node: 'n-impl-3', nextAttempt: 2, wakeAt: T0 + 8 * HOUR },
    },
    {
      seq: at(),
      kind: 'node.started',
      nodeId: 'n-impl-3',
      attempt: 2,
      payload: startedOn('n-impl-3', 2),
    },
    {
      seq: at(),
      kind: 'context.built',
      nodeId: 'n-impl-3',
      attempt: 2,
      payload: { node: 'n-impl-3', attempt: 2, packet: withoutPolicy2 },
    },
    {
      seq: at(),
      kind: 'budget.consumed',
      nodeId: 'n-impl-3',
      attempt: 2,
      payload: spent('n-impl-3', 2, 1.84, 'codex'),
    },
    {
      seq: at(),
      kind: 'node.failed',
      nodeId: 'n-impl-3',
      attempt: 2,
      payload: {
        node: 'n-impl-3',
        attempt: 2,
        failure: {
          reason: 'gate.failed',
          class: 'permanent',
          message: 'the import-boundary gate refused the change three times',
          detail: { criterion: AC3, gate: IMPORT_BOUNDARY_GATE },
          evidence: [handle('impl-3-attempt-2')],
          occurredAtEvent: seq,
          attempt: 2,
        },
      },
    },
  );

  for (const [index, node] of [
    'n-impl-4',
    'n-impl-5',
    'n-impl-6',
    'n-impl-7',
    'n-impl-8',
    'n-impl-9',
    'n-impl-10',
  ].entries()) {
    passed(node, 'claude-code', 0.04 + index / 1_000);
  }

  // ── the gates: three clean, and the one that speaks to AC-3 ────────────────
  gateRan(
    'n-gate-typecheck',
    'typecheck',
    diagnosisVerdict(
      'typecheck',
      'n-impl-3',
      'pass',
      [{ id: 'ac-2', status: 'satisfied' }],
      [],
      'typecheck is clean',
    ),
  );
  gateRan(
    'n-gate-lint',
    'lint',
    diagnosisVerdict('lint', 'n-impl-3', 'pass', [], [], 'lint is clean'),
  );
  gateRan(
    'n-gate-tests',
    'tests',
    diagnosisVerdict(
      'tests',
      'n-impl-3',
      'pass',
      [{ id: 'ac-1', status: 'satisfied' }],
      [],
      'the unit tests pass',
    ),
  );
  gateRan(
    'n-gate-import-boundary',
    IMPORT_BOUNDARY_GATE,
    diagnosisVerdict(
      IMPORT_BOUNDARY_GATE,
      'n-impl-3',
      'fail',
      [{ id: AC3, status: 'unsatisfied' }],
      [
        {
          id: 'f-import-boundary-1',
          severity: 'blocker',
          criterion: AC3,
          location: { file: BUTTON_FILE, line: BUTTON_LINE, blobSha: hex('button-blob', 40) },
          message: `${BUTTON_FILE} imports Tokens from @voyado/ui/internal`,
          evidence: [handle('import-boundary-report')],
        },
        {
          id: 'f-import-boundary-2',
          severity: 'major',
          criterion: AC3,
          location: {
            file: 'packages/ui/src/Dialog.vue',
            line: 7,
            blobSha: hex('dialog-blob', 40),
          },
          message: 'packages/ui/src/Dialog.vue imports Overlay from @voyado/ui/internal',
          evidence: [],
        },
        {
          id: 'f-import-boundary-3',
          severity: 'major',
          criterion: AC3,
          location: {
            file: 'packages/app/src/Shell.vue',
            line: 11,
            blobSha: hex('shell-blob', 40),
          },
          message: 'packages/app/src/Shell.vue imports Layout from @voyado/ui/internal',
          evidence: [],
        },
      ],
      '3 files import from the internal namespace',
    ),
  );

  passed('n-docs', 'claude-code', 0.03);
  passed('n-changelog', 'claude-code', 0.02);
  passed('n-release-notes', 'claude-code', 0.02);

  // ── v4: the legacy branch is abandoned, and the run stops for a human ──────
  drafts.push(
    {
      seq: at(),
      kind: 'plan.patch.proposed',
      payload: { patch: abandonPatchDoc, basePlanHash: hashes[2] },
    },
    {
      seq: at(),
      kind: 'plan.proposed',
      payload: { version: 4, planHash: hashes[3], graph: versions[3], by: 'planner' },
    },
    {
      seq: at(),
      kind: 'plan.patched',
      payload: {
        version: 4,
        fromHash: hashes[2],
        toHash: hashes[3],
        patchId: abandonPatchDoc.id,
        decision: decision('approved', 'human', 'default'),
        proposedBy: 'planner',
      },
    },
    {
      seq: at(),
      kind: 'node.scheduled',
      nodeId: 'n-approve',
      payload: scheduled('n-approve', 'human', 'read'),
    },
    {
      seq: at(),
      kind: 'node.started',
      nodeId: 'n-approve',
      attempt: 0,
      payload: startedOn('n-approve', 0),
    },
    {
      seq: at(),
      kind: 'node.suspended',
      nodeId: 'n-approve',
      attempt: 0,
      payload: { node: 'n-approve', until: { kind: 'human' } },
    },
    {
      seq: at(),
      kind: 'human.requested',
      nodeId: 'n-approve',
      payload: {
        node: 'n-approve',
        prompt: 'One surface failed the import boundary. Ship the rest?',
        options: [
          { id: 'ship', label: 'Ship it', effect: 'approve' },
          { id: 'hold', label: 'Hold', effect: 'reject' },
        ],
      },
    },
  );

  return envelopes(DIAGNOSIS_RUN, drafts);
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
      name: 'repair-attempts',
      run: REPAIR_ATTEMPTS_RUN,
      events: await repairAttemptsEvents(),
      what:
        'One node, three attempts, and **a context packet per attempt** — the only\n' +
        'fixture in the corpus with two packets for the same node. Attempt 2’s packet\n' +
        'gains the history summary and tool output attempt 1 could not have had;\n' +
        'attempt 3’s is identical to attempt 2’s, which is what a repair that changed\n' +
        'nothing looks like from the inside. The ladder ends on\n' +
        '`contract.schema-invalid` carrying its Ajv errors, and a second node fails at\n' +
        '`adapter.spawn-failed` before any packet was ever built.',
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
    {
      name: 'five-minute-diagnosis',
      run: DIAGNOSIS_RUN,
      events: await diagnosisEvents(),
      what:
        'The run [EPIC-17-S35](../../../docs/delivery/flows/EPIC-17-p0-views-flows.md)\n' +
        'is timed over: a design-system migration whose 22 nodes end 18 passed, 1\n' +
        'failed, 2 abandoned and 1 awaiting-human, and whose failure is only\n' +
        'explicable by walking six views in sequence. `n-recon` writes\n' +
        '`decision/import-policy`; `n-impl-3`’s first packet carries it; a\n' +
        '`context.compacted` at `exact` fidelity drops that one segment while keeping\n' +
        'every pin; the two later attempts are built without it; the\n' +
        '`import-boundary` gate then refuses `AC-3` with a blocker at\n' +
        '`packages/ui/src/Button.vue:42`. The plan versions carry the split that\n' +
        'created the node (v2) and the provider re-route that followed it (v3).\n' +
        'This is the only fixture in the corpus that answers all six of the\n' +
        'scenario’s questions from one run.',
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
    'wrote happy-path-12, three-patches, repair-attempts, stress-400 and ' +
      `five-minute-diagnosis into ${RUN_FIXTURES_DIR}\n`,
  );
}
