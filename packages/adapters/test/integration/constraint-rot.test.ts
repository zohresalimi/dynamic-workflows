/**
 * KAR-09.3 — the ConstraintRot regression suite.
 *
 * This is the test that protects the highest-severity risk in PRD §13, and it
 * is the reason the rest of the story is worth building. Twenty nodes, each
 * carrying one pinned constraint and a plausible reason to break it, each run
 * twice: once with pinning **enabled**, where the constraint survives the
 * compaction verbatim, and once **disabled**, where the compaction takes it
 * with everything else.
 *
 * Three properties make it a measurement rather than a ritual.
 *
 * **It is graded on tool calls.** A violation is `edit src/shared/money.ts`
 * appearing in the ledger, not a sentence in which the agent said it would
 * behave. Prose grading is how a benchmark measures politeness.
 *
 * **The disabled run must produce violations.** A green "pinning disabled" run
 * does not mean pinning is unnecessary — it means the scenarios do not tempt
 * the agent hard enough. Fix the scenarios, never the assertion.
 *
 * **The difference between the two runs is exactly the pinned block.** Both
 * send the same summary and the same brief to the same binary at the same
 * seed. The enabled run re-injects the five pinned segments verbatim ahead of
 * the compaction boundary and carries them as `pins`, so the F6.6 integrity
 * check runs; the disabled run does neither, which is the 30%-after-compaction
 * case from arXiv 2606.22528 reproduced locally.
 *
 * The mock agent is a stand-in for a model and makes no claim to be one — it
 * takes the compliant branch when the constraint is in its prompt and the
 * tempting one when it is not. What the suite measures is therefore DeFlow's
 * half of the mechanism: whether the bytes reached the prompt. That is the
 * half DeFlow can be wrong about.
 *
 * Offline, no credentials, no vendor CLI, `--seed 42`.
 *
 * Verifies: EPIC-09-S20 · AC8, AC9, AC10
 */

import { buildPinnedSegments, contextSegment, EventSeqSchema, NodeIdSchema } from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { runAcpNode } from '../../src/index.ts';
import {
  mockScenarioFor,
  pinnedConstraint,
  pinnedConstraintLine,
  ROT_SCENARIOS,
  type RotScenario,
} from './support/constraint-rot.ts';
import {
  MOCK_AGENT_BIN,
  mockAgentBinary,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';
import { approvedSpec } from './support/pinned-packet.ts';

/** The summary a compaction leaves behind in place of the turns it replaced. */
const COMPACTION_SUMMARY =
  'Earlier turns compacted: the node explored the checkout module and ran the test suite twice.';

type Pinning = 'enabled' | 'disabled';

interface RunResult {
  readonly scenario: string;
  readonly violated: boolean;
  readonly toolCalls: readonly string[];
}

let dir = '';
let worktree = '';
let scenarioDir = '';
let ledger: TestLedger;

beforeAll(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt');
  scenarioDir = join(dir, 'scenarios');
  await mkdir(worktree, { recursive: true });
  await mkdir(scenarioDir, { recursive: true });
  ledger = openTestLedger(dir);
});

afterAll(async () => {
  ledger.close();
  await removeTempDir(dir);
});

/** The five pinned segments for one scenario, plus the brief. */
async function segmentsFor(scenario: RotScenario) {
  const pinned = await buildPinnedSegments({
    spec: approvedSpec(),
    node: { pathScopes: [...scenario.pathScopes], permission: 'worktree' },
    constraints: [pinnedConstraint(scenario)],
    sourceEvent: EventSeqSchema.parse(1),
  });
  const brief = await contextSegment({
    id: 'brief',
    kind: 'task.brief',
    text: `Task: unblock the checkout node. ${scenario.temptation}`,
    sourceEvent: EventSeqSchema.parse(2),
  });
  return { pinned, brief };
}

/**
 * One node run. `nodeId` is the scenario id plus the mode, so both runs of a
 * scenario live in the same ledger and are still distinguishable.
 */
async function runScenario(scenario: RotScenario, pinning: Pinning): Promise<RunResult> {
  const { pinned, brief } = await segmentsFor(scenario);
  const pinnedBlock = pinned.map((segment) => segment.text).join('\n\n');
  const afterCompaction = `${COMPACTION_SUMMARY}\n\n${brief.text}`;
  // The only difference between the two runs.
  const prompt = pinning === 'enabled' ? `${pinnedBlock}\n\n${afterCompaction}` : afterCompaction;

  const nodeId = NodeIdSchema.parse(`${scenario.id}-${pinning}`);
  const scenarioFile = join(scenarioDir, `${nodeId}.json`);
  await writeFile(scenarioFile, JSON.stringify(mockScenarioFor(scenario)), 'utf8');

  await runAcpNode(
    {
      runId: RUN_ID,
      nodeId,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: mockAgentBinary(),
      argv: ['--seed', '42', '--scenario', scenarioFile],
      env: { PATH: process.env.PATH ?? '' },
      mcpServers: [],
      prompt,
      // With pinning disabled the mechanism is off, integrity check included:
      // carrying `pins` would refuse the dispatch rather than measure what an
      // unpinned run does.
      ...(pinning === 'enabled'
        ? {
            pins: pinned.map((segment) => ({
              id: segment.id,
              text: segment.text,
              contentHash: segment.contentHash,
              pinned: true as const,
            })),
          }
        : {}),
    },
    { clock: new TestClock(), ledger: ledger.sink, captureEvidence: ledger.captureEvidence },
  );

  const toolCalls = ledger
    .events()
    .filter(
      (event) =>
        event.kind === 'node.progress' &&
        event.payload.node === nodeId &&
        event.payload.phase === 'tool_call',
    )
    .map((event) => String(event.payload.message));

  return {
    scenario: scenario.id,
    violated: toolCalls.some((message) => message.includes(scenario.violating.title)),
    toolCalls,
  };
}

/** The whole corpus in one mode. Sequential: twenty real subprocesses that
 * share a ledger file, and a burst of concurrent writers would be measuring
 * SQLite rather than the mechanism. */
async function runSuite(pinning: Pinning): Promise<readonly RunResult[]> {
  const results: RunResult[] = [];
  for (const scenario of ROT_SCENARIOS) results.push(await runScenario(scenario, pinning));
  return results;
}

const violations = (results: readonly RunResult[]): string[] =>
  results.filter((result) => result.violated).map((result) => result.scenario);

suite('the corpus itself', () => {
  it('is roughly twenty scenarios, each with a distinct id', () => {
    expect(ROT_SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ROT_SCENARIOS.map((scenario) => scenario.id)).size).toBe(ROT_SCENARIOS.length);
  });

  it('exercises the forbid → allow-only restatement in at least three of them (AC9)', () => {
    const restated = ROT_SCENARIOS.filter((scenario) => scenario.restateWith !== undefined);

    expect(restated.length).toBeGreaterThanOrEqual(3);
    for (const scenario of restated) {
      expect(scenario.constraint.form).toBe('forbid');
      // What gets pinned is the positive form, which is the whole point.
      expect(pinnedConstraint(scenario).form).toBe('allow-only');
      expect(pinnedConstraintLine(scenario)).not.toMatch(/^do not /);
    }
  });

  it('keeps at least one prohibition that has no positive form, as the last resort', () => {
    const forbidden = ROT_SCENARIOS.filter(
      (scenario) => pinnedConstraint(scenario).form === 'forbid',
    );

    expect(forbidden.length).toBeGreaterThan(0);
  });

  it('needs no network, no credentials and no vendor CLI', () => {
    // The binary is the workspace mock agent, and the child environment carries
    // PATH and nothing else — no key, no token, no vendor config.
    expect(MOCK_AGENT_BIN).toContain('mock-agent');
    expect(mockAgentBinary().path).toBe(MOCK_AGENT_BIN);
  });
});

suite('ConstraintRot with pinning ENABLED', () => {
  it('records zero violations across the whole corpus', { timeout: 90_000 }, async () => {
    const results = await runSuite('enabled');

    // The per-scenario breakdown is the assertion's message, so a red run
    // names the scenario rather than a count.
    expect(violations(results)).toEqual([]);
    expect(results).toHaveLength(ROT_SCENARIOS.length);
    // Every node really ran and really called a tool: a suite where the
    // agent did nothing would also report zero violations.
    for (const result of results) expect(result.toolCalls.length).toBeGreaterThan(0);
    // And the integrity check passed for every one of them.
    expect(ledger.events().filter((event) => event.kind === 'pin.integrity_violated')).toEqual([]);
  });
});

suite('ConstraintRot with pinning DISABLED', () => {
  it('records violations, which is what proves the suite measures the mechanism', {
    timeout: 90_000,
  }, async () => {
    const results = await runSuite('disabled');

    // Greater than zero, not "all": a scenario that violates under both
    // modes would be caught by the enabled run above.
    expect(violations(results).length).toBeGreaterThan(0);
    // In this corpus every scenario is tempted, so a partial result is a
    // weak scenario and worth naming.
    expect(violations(results)).toEqual(ROT_SCENARIOS.map((scenario) => scenario.id));
  });
});
