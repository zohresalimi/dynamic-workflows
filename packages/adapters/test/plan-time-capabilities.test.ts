/**
 * KAR-11.2 §3.2 — what plan validation is allowed to know about an adapter,
 * projected from the probed row and from the committed 2026-08-02 fixtures.
 *
 * The two fixtures under `fixtures/capabilities/` are the point of this file.
 * EPIC-11-S9 names them by version — `claude-agent-acp 0.64.1`, which advertises
 * `sessionCapabilities.resume`, and `gemini-cli 0.53.1`, which advertises no
 * `sessionCapabilities` key whatsoever — and the epic's own risk register says
 * the matrix must be *"committed as a **fixture**, regenerated on every `DeFlow
 * doctor`"*, never a constant. So the severity rule in `validatePlan` is
 * exercised here against bytes a real handshake produced, and the constant that
 * would replace them is exactly what this file would stop failing about.
 *
 * Verifies: EPIC-11-S8, EPIC-11-S9 · KAR-11.2 AC5, AC6
 */
import {
  NODE_TYPES,
  type PlanGraph,
  PlanGraphSchema,
  type PlanTimeCapability,
  resumeByReplayNodes,
  type TaskSpec,
  TaskSpecSchema,
  TOOL_KINDS,
  validatePlan,
} from '@DeFlow/core';

/** "Assume everything is performable": KAR-23.9's own check has its own suites
 * in `@DeFlow/core` and `@DeFlow/daemon`, and this file is about the capability
 * refusals. */
const ANYTHING_PERFORMABLE = { nodeTypes: [...NODE_TYPES], toolKinds: [...TOOL_KINDS] };

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import type { CapabilityRow } from '../src/capabilities.ts';
import { planTimeCapabilities } from '../src/plan-time-capabilities.ts';

const fixturesDir = new URL('../../../fixtures/capabilities/', import.meta.url).pathname;

/** One probed row, with the fixture's bytes as its `caps_json` column. */
function fixtureRow(file: string, provider: string, version: string): CapabilityRow {
  return {
    provider,
    version,
    binarySha256: 'a'.repeat(64),
    binaryPath: `/opt/bin/${provider}`,
    capsJson: readFileSync(join(fixturesDir, file), 'utf8'),
    probedAt: 1_754_380_800_000,
  } as CapabilityRow;
}

const RESUMES = fixtureRow('claude-agent-acp@0.64.1.json', 'claude', '0.64.1');
const NO_RESUME = fixtureRow('gemini-cli@0.53.1.json', 'gemini', '0.53.1');

const WINDOW = 200_000;
const windows = () => WINDOW;

const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1' },
  brief: `do ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
  ...over,
});

function graph(nodes: unknown[]): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: 'run_20260808T101500Z_ac1102',
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-08T10:15:00.000Z',
    nodes,
    edges: [],
  });
}

const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'migrate the app',
  scope: { included: ['the app'] },
  nonGoals: ['rewriting the backend'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'it works', check: { kind: 'manual', rubric: 'a human looks' } },
  ],
  knownFailureModes: [],
  approvedBy: null,
  specHash: `sha256-${'2'.repeat(64)}`,
});

const validate = (plan: PlanGraph, caps: readonly PlanTimeCapability[]) =>
  validatePlan(plan, SPEC, caps, {
    estimatePacketTokens: () => 0,
    performable: ANYTHING_PERFORMABLE,
  });

/**
 * The resume diagnostics only.
 *
 * `gemini-cli` takes no schema flag, so a node routed onto it also collects a
 * `NO_STRUCTURED_OUTPUT` error — a true finding about the same fixture, and one
 * this suite is not about. Filtering by code says which claim is under test
 * instead of restating a second module's answer in this file's expectations.
 */
const resumeDiagnostics = (plan: PlanGraph, caps: readonly PlanTimeCapability[]) =>
  validate(plan, caps).filter((diagnostic) => diagnostic.code === 'NO_RESUME');

suite('the projection answers from the row, never from a table (AC5)', () => {
  it('reads resume support out of the two committed fixtures, and they disagree', () => {
    const [claude, gemini] = planTimeCapabilities([RESUMES, NO_RESUME], windows);

    expect(claude).toMatchObject({ provider: 'claude', version: '0.64.1', resume: true });
    expect(gemini).toMatchObject({ provider: 'gemini', version: '0.53.1', resume: false });
  });

  it('is one entry per row: delete the row and the provider is gone', () => {
    expect(planTimeCapabilities([NO_RESUME], windows).map((one) => one.provider)).toEqual([
      'gemini',
    ]);
  });

  it('offers only `read` where the row cannot mediate execution (F5.4, 09 §8.3)', () => {
    const unmediated: CapabilityRow = {
      ...NO_RESUME,
      capsJson: JSON.stringify({ agentCapabilities: { _meta: { mediatedExecution: false } } }),
    };

    expect(planTimeCapabilities([unmediated], windows)[0]?.permissionLevels).toEqual(['read']);
  });

  it('offers the whole ladder where the row never mentioned mediation', () => {
    // An unadvertised `mediatedExecution` is not a denial — no ACP adapter
    // measured so far advertises it, and treating absence as `false` would make
    // the entire installed fleet unschedulable above `read`.
    expect(
      planTimeCapabilities([RESUMES, NO_RESUME], windows).map((one) => one.permissionLevels),
    ).toEqual([
      ['read', 'worktree', 'worktree+net', 'full'],
      ['read', 'worktree', 'worktree+net', 'full'],
    ]);
  });

  it('takes the window from the caller, because no handshake advertises one', () => {
    const perProvider = (provider: string) => (provider === 'gemini' ? 1_000_000 : WINDOW);

    expect(
      planTimeCapabilities([RESUMES, NO_RESUME], perProvider).map((one) => one.maxContext),
    ).toEqual([WINDOW, 1_000_000]);
  });
});

suite('EPIC-11-S9 — NO_RESUME severity, against the real fixtures (AC6)', () => {
  const caps = planTimeCapabilities([RESUMES, NO_RESUME], windows);
  const preferGemini = { prefer: ['gemini'], requires: [] };

  it('gemini 0.53.1 + `native-if-available` is a warning and a replay annotation', () => {
    const plan = graph([agent('impl', { resume: 'native-if-available', provider: preferGemini })]);

    const diagnostics = resumeDiagnostics(plan, caps);
    expect(diagnostics).toMatchObject([{ severity: 'warning', code: 'NO_RESUME', node: 'impl' }]);
    expect(resumeByReplayNodes(diagnostics)).toEqual(['impl']);
  });

  it('gemini 0.53.1 + a declared `resumableSessions` requirement is an error', () => {
    const plan = graph([
      agent('impl', { provider: { prefer: ['gemini'], requires: ['resumableSessions'] } }),
    ]);

    expect(resumeDiagnostics(plan, caps)).toMatchObject([{ severity: 'error', code: 'NO_RESUME' }]);
  });

  it('claude-agent-acp 0.64.1 produces neither diagnostic, for either node', () => {
    const plan = graph([
      agent('soft', { resume: 'native-if-available' }),
      agent('hard', { provider: { prefer: ['claude'], requires: ['resumableSessions'] } }),
    ]);

    expect(validate(plan, caps)).toEqual([]);
  });
});
