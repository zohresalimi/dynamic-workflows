/**
 * KAR-02.7 — one valid payload per event kind, table-driven.
 *
 * Hand-written rather than generated: a generated fixture would satisfy the
 * schema by construction and prove nothing about whether the schema says what
 * docs/04-domain-model.md §9's table says.
 *
 * It lives here rather than inside one spec because two suites need the same
 * corpus for opposite reasons — ../event-payload-fixtures.test.ts asks whether
 * every schema accepts a real payload, and KAR-03.5's ../reduce-corpus.test.ts
 * asks whether the reducer survives one of every kind — and a second,
 * drifting copy of forty-one payloads would make the second suite prove
 * nothing about the first's events.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventKind } from '../../src/event-payloads.ts';

const fixture = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

const taskSpec = fixture('../fixtures/specs/vue3-migration.json');
const planGraph = fixture('../fixtures/plans/seven-types.json');
const planPatch = fixture('../fixtures/patches/three-ops.json');

export const RUN_ID = 'run_20260802T141133Z_9f2a1c';
export const NODE = 'recon-auth-surface';
export const SHA = `sha256-${'a'.repeat(64)}`;
export const OTHER_SHA = `sha256-${'c'.repeat(64)}`;
export const BARE_SHA = 'd'.repeat(64);
export const HANDLE = `artifact://${'b'.repeat(64)}`;
export const IKEY = `${RUN_ID}/${NODE}/1/0`;
export const AT = '2026-08-02T14:11:33.000Z';

export const usage = { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' };

export const completedResult = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage,
  costUsd: 0.42,
  producedFacts: [`fact_${'a'.repeat(26)}`],
  artifacts: [HANDLE],
};

const nodeFailure = {
  reason: 'adapter.spawn-failed',
  class: 'transient',
  message: 'claude-code exited before the handshake completed',
  evidence: [HANDLE],
  occurredAtEvent: 42,
  attempt: 1,
};

const fact = {
  id: `fact_${'a'.repeat(26)}`,
  key: 'finding/auth-uses-jwt',
  kind: 'finding',
  schemaId: 'DeFlow.finding.v1',
  value: { detail: 'the verifier is jose' },
  provenance: {
    byNode: NODE,
    byProvider: 'claude-code',
    byModel: 'claude-sonnet-4-6',
    fromEvidence: [HANDLE],
    atEvent: 30,
    at: AT,
    confidence: 'verified',
  },
};

const verdict = {
  schemaId: 'DeFlow.verdict.v1',
  outcome: 'pass',
  gate: 'codemod-review',
  evaluatedNode: NODE,
  by: { node: 'review-gate', provider: 'codex', model: 'gpt-5-codex' },
  criteria: [{ id: 'unit-tests-pass', status: 'satisfied' }],
  findings: [],
  summary: 'Every criterion this gate speaks to is satisfied.',
};

/** A packet as the ledger records it: no segment carries `text`. */
const packetRecord = {
  schemaId: 'DeFlow.contextpacket.v1',
  runId: RUN_ID,
  nodeId: NODE,
  attempt: 1,
  builtAtEvent: 30,
  target: { provider: 'claude-code', model: 'claude-sonnet-4-6', maxContext: 200_000 },
  budget: { fraction: 0.5, limitTokens: 100_000 },
  segments: [
    {
      id: 'seg-brief',
      kind: 'task.brief',
      sourceEvent: 10,
      contentHash: SHA,
      tokens: { estimated: 40, method: 'gpt-tokenizer/o200k_base' },
      pinned: true,
      compactable: false,
    },
  ],
  totals: {
    tokens: 40,
    byKind: {
      'pinned.constraints': 0,
      'pinned.spec': 0,
      'pinned.pathscope': 0,
      'task.brief': 40,
      fact: 0,
      'artifact.handle': 0,
      retrieved: 0,
      'history.summary': 0,
      'tool.output': 0,
    },
  },
  renderedPromptHandle: HANDLE,
  pinnedDigests: [SHA],
};

/** One representative payload per kind, in §9's order. */
export const PAYLOADS: Record<EventKind, unknown> = {
  'run.created': {
    spec: taskSpec,
    cwd: '/Users/dev/projects/shop',
    repo: { head: 'e83c516', branch: 'main' },
  },
  'run.spec.approved': { specHash: SHA, by: 'ui' },
  'run.started': { planHash: SHA },
  'run.paused': { by: 'user', reason: 'stepping away' },
  'run.resumed': { by: 'user' },
  'run.cancel.requested': { mode: 'cooperative' },
  'run.completed': { outcome: 'succeeded', criteriaSatisfied: ['unit-tests-pass'] },
  'run.aborted': { outcome: 'failed', criteriaSatisfied: [] },
  'run.stalled': { watermarkSeq: 8000, idleMs: 900_000, runningNodes: [NODE] },
  'run.kill_failed': {
    survivors: [{ node: NODE, attempt: 1, pid: 48_215, pgid: 48_213, stat: 'D' }],
  },
  'run.needs_human': { reason: 'churn', detail: 'four replans in twelve minutes' },
  'plan.proposed': { version: 1, planHash: SHA, graph: planGraph, by: 'planner' },
  'plan.patch.proposed': { patch: planPatch },
  'plan.patched': {
    version: 2,
    fromHash: SHA,
    toHash: OTHER_SHA,
    patchId: 'patch-3a91f0',
    decision: { decision: 'auto', by: 'policy', rule: 'small-blast-radius', at: AT },
  },
  'plan.patch.rejected': { patchId: 'patch-3a91f0', rule: 'permission-escalation', by: 'policy' },
  'node.scheduled': {
    node: NODE,
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    permission: 'worktree',
  },
  'node.lock.acquired': { node: NODE, lock: 'worktree', key: `${RUN_ID}__${NODE}` },
  'node.lock.released': { node: NODE, lock: 'repo', key: 'repo' },
  'node.started': {
    node: NODE,
    attempt: 1,
    ikey: IKEY,
    binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: BARE_SHA },
  },
  'node.progress': { node: NODE, attempt: 1, phase: 'tool-use', message: 'reading src/auth' },
  'node.completed': { node: NODE, attempt: 1, result: completedResult },
  'node.failed': { node: NODE, attempt: 1, failure: nodeFailure },
  'node.retry.scheduled': { node: NODE, nextAttempt: 2, wakeAt: 1_754_313_093_000 },
  'node.suspended': { node: NODE, until: { kind: 'wake', wakeAt: AT } },
  'node.blocked': {
    node: NODE,
    conflictsWith: 'implement-auth',
    branch: `DeFlow/r1__${NODE}`,
    otherBranch: 'DeFlow/r1__implement-auth',
    paths: ['src/a.ts'],
  },
  'node.unschedulable': {
    node: NODE,
    provider: 'claude-code',
    version: '2.1.220',
    permission: 'worktree',
    reason: 'mediatedExecution:false',
  },
  'permission.denied': {
    node: NODE,
    attempt: 0,
    permission: 'worktree',
    method: 'fs/write_text_file',
    requested: '../../etc/passwd',
    reason: { code: 'path-escape', detail: 'traversal' },
  },
  'env.declared': { node: NODE, attempt: 0, name: 'NPM_TOKEN' },
  'sandbox.degraded': {
    node: NODE,
    attempt: 0,
    provider: 'claude',
    key: 'sandbox.network.strictAllowlist',
    detected: '2.1.218',
    required: '2.1.219',
  },
  'node.cancelled': { node: NODE, attempt: 1, result: { status: 'cancelled', by: 'user' } },
  'node.cancel.stage': {
    node: NODE,
    attempt: 1,
    stage: 'sigterm',
    mode: 'forceful',
    pid: 48_213,
    pgid: 48_213,
    elapsedMs: 0,
  },
  'node.cancel.failed': { node: NODE, attempt: 1, pid: 48_213, pgid: 48_213, survivors: [48_215] },
  'workspace.worktree_created': {
    node: NODE,
    path: `/tmp/repo/.DeFlow/wt/${RUN_ID}__${NODE}`,
    branch: `DeFlow/${RUN_ID}__${NODE}`,
    baseRef: 'main',
    detached: false,
    lockReason: `DeFlow run=${RUN_ID} node=${NODE}`,
  },
  'workspace.branch_occupied': {
    node: NODE,
    branch: 'main',
    occupiedBy: '/tmp/repo',
    occupantKind: 'main-checkout',
  },
  'workspace.included_file': { node: NODE, path: '.env', mode: '0600' },
  'workspace.setup_cache_hit': { node: NODE, key: SHA, files: ['pnpm-lock.yaml'] },
  'workspace.dirty_on_remove': {
    node: NODE,
    path: `/tmp/repo/.DeFlow/wt/${RUN_ID}__${NODE}`,
    entries: [
      { kind: 'changed', xy: '.M', path: 'src/a.ts', origPath: null },
      { kind: 'renamed', xy: 'R.', path: 'src/new name.ts', origPath: 'src/old name.ts' },
      { kind: 'untracked', xy: null, path: 'src/new.ts', origPath: null },
    ],
  },
  'workspace.wip_salvaged': {
    node: NODE,
    path: `/tmp/repo/.DeFlow/wt/${RUN_ID}__${NODE}`,
    branch: `DeFlow/${RUN_ID}__${NODE}`,
    detached: false,
    oid: BARE_SHA.slice(0, 40),
    files: 3,
  },
  'workspace.worktree_removed': {
    node: NODE,
    path: `/tmp/repo/.DeFlow/wt/${RUN_ID}__${NODE}`,
    branch: `DeFlow/${RUN_ID}__${NODE}`,
    tipOid: BARE_SHA.slice(0, 40),
  },
  'workspace.reconciled': {
    added: [],
    removed: ['/tmp/repo/.DeFlow/wt/gone'],
    prunable: ['/tmp/repo/.DeFlow/wt/rm-rfed'],
  },
  'workspace.pid_recycled': {
    node: NODE,
    pid: 41_233,
    recorded: 'Wed Aug  5 10:15:00 2026',
    observed: 'Thu Aug  6 09:02:11 2026',
  },
  'workspace.orphan_reaped': {
    node: NODE,
    path: `/tmp/repo/.DeFlow/wt/${RUN_ID}__${NODE}`,
    pid: 41_233,
  },
  'workspace.merge_queue_reordered': {
    branch: `DeFlow/int/${RUN_ID}`,
    mergedNode: NODE,
    before: ['plan-migration', 'run-lint'],
    after: ['run-lint', 'plan-migration'],
  },
  'effect.started': { ikey: IKEY, kind: 'git', requestHash: SHA },
  'effect.completed': { ikey: IKEY, result: { commit: BARE_SHA }, reconciled: false },
  'effect.failed': { ikey: IKEY, failure: nodeFailure },
  'effect.cancelled': { ikey: IKEY, result: { status: 'cancelled', by: 'user' } },
  'context.built': { node: NODE, attempt: 1, packet: packetRecord },
  'context.compacted': {
    node: NODE,
    scope: 'vendor.session',
    fidelity: 'partial',
    trigger: 'vendor.auto',
    before: 148_000,
    after: null,
    droppedSegments: [],
    demotedToHandles: [],
    pinnedKept: [SHA],
    originalHandle: null,
  },
  'pin.integrity_violated': {
    node: NODE,
    attempt: 1,
    missingDigests: [SHA],
    segmentIds: ['seg-brief'],
  },
  'fact.written': { fact },
  'fact.read': { factId: fact.id, key: fact.key, by: 'harden-auth-tests' },
  'fact.invalidated': {
    factId: fact.id,
    by: 'harden-auth-tests',
    reason: 'the verifier was replaced in a later commit',
    taints: [NODE],
  },
  'handoff.oversize': {
    node: NODE,
    attempt: 1,
    budget: 1500,
    actual: 9200,
    repairAttempted: true,
  },
  'gate.evaluated': { gate: 'codemod-review', node: NODE, verdict },
  'human.requested': {
    node: 'approve-migration',
    prompt: 'The codemod changed 41 files. Proceed?',
    options: [{ id: 'yes', label: 'Proceed', effect: 'approve' }],
    deadline: { wakeAt: AT, onTimeout: 'escalate' },
  },
  'human.responded': { node: 'approve-migration', optionId: 'yes', at: AT },
  'budget.consumed': { node: NODE, provider: 'claude-code', usage, costUsd: 0.42 },
  'budget.exceeded': { scope: 'run', dimension: 'cost', limit: 20, actual: 21.4 },
  'provider.probed': {
    provider: 'claude-code',
    version: '2.1.220',
    capsJson: { structuredOutput: true },
    binarySha256: BARE_SHA,
  },
  'provider.rate_limited': {
    provider: 'claude-code',
    resetsAt: 1_754_313_093_000,
    raw: { type: 'rate_limit_event' },
  },
  'export.blocked': { target: 'report', reason: 'redaction-failed', count: 3 },
};
