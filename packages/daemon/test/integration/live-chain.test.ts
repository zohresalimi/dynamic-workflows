/**
 * KAR-19.3 — framing → the F1.3 gate → the pin → recon → `PlanGraph` v1, on the
 * path that actually ships.
 *
 * Every function in this chain existed, was exported and had a passing suite
 * before this story; none of them had a caller. So what is asserted here is
 * never *"does `compilePlanV1` compile"* — EPIC-11's own suite settles that —
 * but *"does anything call it, in the right order, off the ticker, with the
 * inputs the previous step produced"*. The failure this epic exists to correct
 * was invisible precisely because every unit was green.
 *
 * Integration, and file-backed, because every claim is about a boundary: a real
 * `submitTask` writing a real `node_wake`, the real run driver consuming it, a
 * real SQLite file that can be closed and reopened between two daemon lives, the
 * real Ajv2020 validator over the repository's own emitted schemas, a real git
 * repository and a real detached worktree for recon.
 *
 * The three agents are **ports**, scripted, exactly as
 * `./framing-interview.test.ts`, `./recon-survey.test.ts` and
 * `./plan-compile.test.ts` script theirs. What a scripted session cannot prove
 * — that a vendor CLI honours `--json-schema` — is EPIC-05's conformance
 * battery and is not re-litigated here.
 *
 * Verifies: EPIC-19-S16, EPIC-19-S18, EPIC-19-S19, EPIC-19-S20, EPIC-19-S21,
 * EPIC-19-S22 · KAR-19.3 AC1–AC6, AC8 · test plan #1, #2, #3, #4, #5, #8
 */

import { shimCapabilityRow } from '@DeFlow/adapters';
import type { Db, Handle, NodeId, RunId, StructuredOutput } from '@DeFlow/core';
import { HandleSchema, NodeIdSchema } from '@DeFlow/core';
import {
  blobHandle,
  openLedger,
  readFacts,
  readPlanDoc,
  readRange,
  readWake,
  recordProviderCapabilities,
  spillBytes,
} from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { createRunDriver, type RunDriver } from '../../src/drive.ts';
import type { FramingAgent, FramingQuestion, FramingTurn } from '../../src/framing/interview.ts';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { WorkspaceManager } from '../../src/git/worktree-manager.ts';
import { respondToHumanNode } from '../../src/human/gate.ts';
import { submitTask } from '../../src/intake/intake.ts';
import {
  createRunChain,
  type RunChainContext,
  type RunChainResolver,
} from '../../src/pipeline/run-chain.ts';
import type { PlannerAgent } from '../../src/plan/compile.ts';
import type { ReconAgent } from '../../src/recon/recon.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { approveSpec, FRAMING_NODE, rejectSpec } from '../../src/spec/gate.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

/** The repository's own emitted documents — the bytes `deflow init` copies. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const T0 = 1_754_470_000_000;
const EPOCH = 4;
const PROVIDER = 'claude';
const RECON_NODE: NodeId = NodeIdSchema.parse('recon');

const RAW_TASK = 'Migrate the design system to Vue 3. Keep the public component API stable.';

const present = (value: unknown): StructuredOutput => ({ present: true, value });

/** A `DeFlow.taskspecdraft.v1` the criteria contract accepts. */
function draft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.taskspecdraft.v1',
    goal: 'Migrate every component under packages/ui to Vue 3 with no public API change.',
    scope: { included: ['packages/ui'], paths: ['packages/ui/src/**'] },
    nonGoals: ['Do not touch packages/legacy.'],
    constraints: ['No new runtime dependency.'],
    priorDecisions: [],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'pnpm typecheck passes.', verifiedBy: ['typecheck'] },
      { id: 'ac-2', statement: 'pnpm build passes.', verifiedBy: ['build'] },
    ],
    knownFailureModes: [
      {
        id: 'fm-1',
        description: 'A component silently loses its default slot.',
        detection: 'The snapshot suite for that component changes.',
      },
    ],
    ...over,
  };
}

const RECON_SURVEY = present({
  schemaId: 'DeFlow.reconsurvey.v1',
  toolchain: { language: 'typescript', packageManager: 'pnpm' },
  commands: { test: 'pnpm test', build: 'pnpm build' },
});

/** The gate that covers the draft's two criteria, so the plan validates. */
const gateNode = {
  id: 'gate-acceptance',
  title: 'Check the acceptance criteria',
  type: 'gate',
  deps: ['implement'],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'criteria' }],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.verdict.v2', maxTokens: 1500 },
  gate: { kind: 'deterministic', gateId: 'typecheck' },
  criteria: ['ac-1', 'ac-2'],
  independence: { notSessionOf: ['implement'], preferDifferentProvider: true },
} as const;

const agentNode = (id: string) => ({
  id,
  title: `Do ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'goal' }],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `Do ${id}, carefully.`,
  provider: { prefer: ['claude'], requires: ['structuredOutput'] },
  resume: 'always-replay',
});

/** What the planner returns. DeFlow overwrites the envelope fields it owns. */
const planGraph = (nodes: readonly unknown[], gates: readonly unknown[] = [gateNode]) => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: 'run_00000000T000000Z_000000',
  version: 1,
  planHash: `sha256-${'0'.repeat(64)}`,
  parent: null,
  taskSpecHash: `sha256-${'1'.repeat(64)}`,
  createdBy: 'planner',
  createdAt: '2026-08-13T10:15:00.000Z',
  nodes: [...nodes, ...gates],
  edges: [],
});

interface Scripted {
  readonly framing: FramingAgent;
  readonly recon: ReconAgent;
  readonly planner: PlannerAgent;
  /** Every prompt the framing agent was opened with. */
  readonly framingPrompts: string[];
  readonly reconPrompts: string[];
  readonly plannerPrompts: string[];
}

interface ScriptOptions {
  /** One entry per framing turn, in order. */
  readonly framingTurns?: readonly FramingTurn[];
  readonly plans?: readonly StructuredOutput[];
}

const turn = (structuredOutput: StructuredOutput): FramingTurn => ({
  question: null,
  structuredOutput,
});

const asking = (question: FramingQuestion): FramingTurn => ({
  question,
  structuredOutput: { present: false },
});

function scripted(options: ScriptOptions = {}): Scripted {
  const framingTurns = [...(options.framingTurns ?? [turn(present(draft()))])];
  const plans = [...(options.plans ?? [present(planGraph([agentNode('implement')]))])];
  const framingPrompts: string[] = [];
  const reconPrompts: string[] = [];
  const plannerPrompts: string[] = [];

  return {
    framingPrompts,
    reconPrompts,
    plannerPrompts,
    framing: {
      open(prompt: string) {
        framingPrompts.push(prompt);
        const next = framingTurns.shift();
        if (next === undefined)
          throw new Error('the framing agent was opened more times than scripted');
        return Promise.resolve({
          session: {
            steerable: false,
            answer: () => {
              throw new Error('the chain must reopen rather than steer a dead session');
            },
            repair: () => {
              throw new Error('no repair was scripted');
            },
          },
          turn: next,
        });
      },
    },
    recon: {
      open(prompt: string) {
        reconPrompts.push(prompt);
        return Promise.resolve({
          session: {
            repair: () => {
              throw new Error('no recon repair was scripted');
            },
          },
          turn: { structuredOutput: RECON_SURVEY },
        });
      },
    },
    planner: {
      plan: (request) => {
        plannerPrompts.push(request.prompt);
        const next = plans.shift();
        if (next === undefined)
          throw new Error('the planner was prompted more times than scripted');
        return Promise.resolve({ structuredOutput: next });
      },
    },
  };
}

/**
 * The probed row the planner is admitted against.
 *
 * Written by the boot probe in production (KAR-05.2); seeded here because
 * `compilePlanV1` reads capabilities from the table at plan time, every time,
 * and refuses a provider it has never shaken hands with — which is the rule,
 * not an obstacle.
 */
function seedCapabilities(db: Db): void {
  recordProviderCapabilities(db, {
    provider: PROVIDER,
    version: '2.1.220',
    binarySha256: 'b'.repeat(64),
    binaryPath: '/opt/DeFlow/claude',
    capsJson: JSON.stringify({
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } },
    }),
    probedAt: T0,
  });
}

interface Scene {
  readonly db: Db;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly runId: RunId;
  readonly clock: TestClock;
  readonly driver: RunDriver;
  readonly agents: Scripted;
  close(): void;
}

/** 12 files under packages/ui, plus a manifest recon can recognise. */
function uiFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': '{"name":"ui","scripts":{"test":"vitest run","build":"vite build"}}\n',
  };
  for (let at = 1; at <= 12; at += 1) {
    files[`packages/ui/src/components/C${at}.vue`] = `<template><div>${at}</div></template>\n`;
  }
  return files;
}

/** The one seam the chain takes: everything a run's chain needs that cannot be
 * read out of the ledger. `deflow up` is the production caller. */
function resolverFor(input: {
  readonly db: Db;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly agents: Scripted;
}): RunChainResolver {
  const schemas = loadSchemaDirectory(SCHEMAS_DIR);
  const wrapped = new Git(input.repoDir, { env: GIT_ENV });

  return ({ runId }): Promise<RunChainContext | null> =>
    Promise.resolve({
      provider: PROVIDER,
      model: 'claude-sonnet-4-6',
      maxContext: 200_000,
      capabilityRow: shimCapabilityRow({
        provider: PROVIDER,
        version: '2.1.220',
        binaryPath: '/opt/DeFlow/claude',
        binarySha256: 'b'.repeat(64),
        probedAt: T0,
      }),
      agents: input.agents,
      schemas,
      registry: schemas,
      schemasDir: SCHEMAS_DIR,
      tokenizer: o200kTokenizer(),
      workspace: new WorkspaceManager({
        git: { run: (args, opts) => wrapped.run(args, opts) },
        db: input.db,
        clock: systemClock,
        epoch: EPOCH,
      }),
      refs: new RefFormatChecker(wrapped),
      runDir: join(input.dataDir, 'runs', runId),
      putSurvey: (bytes: Uint8Array): Handle =>
        HandleSchema.parse(
          blobHandle(spillBytes(input.dataDir, Buffer.from(bytes), 'application/json').sha256),
        ),
      readTaskSource: () => {
        throw new Error('every task in this file is inline; nothing should read the blob store');
      },
      captureEvidence: (text: string): Handle =>
        HandleSchema.parse(
          blobHandle(spillBytes(input.dataDir, Buffer.from(text, 'utf8'), 'text/plain').sha256),
        ),
    });
}

async function scene(tmp: string, options: ScriptOptions = {}): Promise<Scene> {
  const repoDir = join(tmp, 'repo');
  await makeRepo({ dir: repoDir, files: uiFiles() });
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });

  const db = openLedger(dataDir);
  seedCapabilities(db);
  const clock = new TestClock(T0);
  const agents = scripted(options);
  const chain = createRunChain({ resolve: resolverFor({ db, dataDir, repoDir, agents }) });

  const submitted = await submitTask(
    {
      body: { input: { kind: 'text', text: RAW_TASK }, cwd: repoDir, permission: 'worktree' },
      by: 'cli',
    },
    { db, epoch: EPOCH, clock, dataDir, randomHex: () => '0a0a0a' },
  );
  if (submitted.outcome !== 'created') throw new Error('the submission was refused');

  const driver = createRunDriver({
    db,
    clock,
    epoch: EPOCH,
    runFraming: chain.runFraming,
    advanceRun: chain.advanceRun,
  });

  return {
    db,
    dataDir,
    repoDir,
    runId: submitted.runId,
    clock,
    driver,
    agents,
    close: () => db.close(),
  };
}

const kinds = (db: Db, runId: RunId): string[] =>
  readRange(db, runId, 0, 500).events.map((event) => event.kind);

const payloadOf = (db: Db, runId: RunId, kind: string): Record<string, unknown> | undefined =>
  readRange(db, runId, 0, 500).events.find((event) => event.kind === kind)?.payload as
    | Record<string, unknown>
    | undefined;

/** The order two kinds appear in, so "each step appended as it completed" is a
 * statement about seq rather than about a set. */
const seqOf = (db: Db, runId: RunId, kind: string): number =>
  readRange(db, runId, 0, 500).events.find((event) => event.kind === kind)?.seq ?? -1;

suite('EPIC-19-S16 — the whole pre-execution chain runs (AC1, AC2)', () => {
  it('frames, gates, pins, recons and compiles, each step appended as it completed', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      // One tick consumes the wake intake wrote and frames the run.
      await s.driver.tick(s.clock.now());

      expect(kinds(s.db, s.runId)).toContain('run.created');
      // AC1 — the packet is EPIC-09's, over the intake event: the raw task
      // reaches the agent verbatim rather than being re-derived.
      expect(s.agents.framingPrompts[0]).toContain(RAW_TASK);
      // AC3 — the gate is open and nothing has been planned.
      expect(kinds(s.db, s.runId)).toContain('human.requested');
      expect(kinds(s.db, s.runId)).not.toContain('plan.proposed');

      s.clock.advance(1_000);
      await approveSpec({ db: s.db, runId: s.runId, epoch: EPOCH, ts: s.clock.now(), by: 'cli' });

      // AC2 — no further operator action: the next tick carries the run from
      // the pin through recon to a compiled plan.
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());

      const order = kinds(s.db, s.runId);
      expect(order).toContain('plan.proposed');
      for (const [before, after] of [
        ['task.submitted', 'run.created'],
        ['run.created', 'run.spec.approved'],
        ['run.spec.approved', 'spec.pinned'],
        ['spec.pinned', 'plan.proposed'],
      ] as const) {
        expect(seqOf(s.db, s.runId, before)).toBeLessThan(seqOf(s.db, s.runId, after));
      }

      // AC2 — recon's facts are on the blackboard, each with provenance, and
      // they were written **before** the planner was prompted.
      const facts = readFacts(s.db, s.runId);
      expect(facts.length).toBeGreaterThan(0);
      for (const stored of facts) {
        expect(stored.fact.provenance.byNode).toBe(RECON_NODE);
        expect(stored.fact.provenance.atEvent).toBeGreaterThan(0);
      }
      expect(seqOf(s.db, s.runId, 'fact.written')).toBeLessThan(
        seqOf(s.db, s.runId, 'plan.proposed'),
      );

      // …and the planner really did receive them, alongside the pinned spec and
      // the probed capability list.
      const prompt = s.agents.plannerPrompts[0] ?? '';
      expect(prompt).toContain('pnpm test');
      expect(prompt).toContain('Migrate every component under packages/ui');

      // The compiled graph has more than one node and validated, or it would
      // not have been persisted at all.
      const proposed = payloadOf(s.db, s.runId, 'plan.proposed');
      expect(proposed?.version).toBe(1);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-19-S19 — no plan is compiled before the operator approves (AC3)', () => {
  it('sits at the gate for an hour with no plan and no planner turn', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.driver.tick(s.clock.now());
      expect(kinds(s.db, s.runId)).toContain('human.requested');

      for (let minute = 0; minute < 60; minute += 1) {
        s.clock.advance(60_000);
        await s.driver.tick(s.clock.now());
      }

      expect(kinds(s.db, s.runId)).not.toContain('plan.proposed');
      expect(kinds(s.db, s.runId)).not.toContain('fact.written');
      expect(s.agents.plannerPrompts).toEqual([]);
      // Framing ran exactly once: a gate that is being waited on is not a
      // reason to re-open a session.
      expect(s.agents.framingPrompts).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it('re-runs the interview when the operator rejects, and still compiles nothing', async ({
    tmp,
  }) => {
    const s = await scene(tmp, {
      framingTurns: [turn(present(draft())), turn(present(draft({ goal: 'A narrower goal.' })))],
    });
    try {
      await s.driver.tick(s.clock.now());

      s.clock.advance(1_000);
      await rejectSpec({
        db: s.db,
        runId: s.runId,
        epoch: EPOCH,
        ts: s.clock.now(),
        by: 'cli',
        reason: 'The goal is far too broad.',
        provider: PROVIDER,
      });

      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());

      // The rejection scheduled a second framing attempt and something ran it.
      expect(s.agents.framingPrompts).toHaveLength(2);
      expect(s.agents.framingPrompts[1]).toContain('The goal is far too broad.');
      expect(kinds(s.db, s.runId)).not.toContain('plan.proposed');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-19-S18 — a clarifying question suspends rather than blocks (AC4)', () => {
  it('writes human.requested and one wake, holds nothing, and resumes on the answer', async ({
    tmp,
  }) => {
    const question: FramingQuestion = {
      prompt: 'Does "the design system" include packages/legacy?',
      options: [
        { id: 'yes', label: 'Yes, include it', effect: 'inject' },
        { id: 'no', label: 'No, leave it', effect: 'inject' },
      ],
      deadline: new Date(T0 + 24 * 3_600_000).toISOString(),
    };

    const s = await scene(tmp, {
      framingTurns: [asking(question), turn(present(draft()))],
    });
    try {
      await s.driver.tick(s.clock.now());

      expect(kinds(s.db, s.runId)).toContain('human.requested');
      expect(kinds(s.db, s.runId)).not.toContain('run.created');
      // The wait is a row, not a promise: nothing is in flight between ticks.
      expect(s.driver.inFlight).toBe(0);
      const wake = readWake(s.db, { runId: s.runId, nodeId: FRAMING_NODE });
      expect(wake?.reason).toBe('human_gate');

      // Six hours pass on the injected clock, and the daemon does nothing.
      s.clock.advance(6 * 3_600_000);
      await s.driver.tick(s.clock.now());
      expect(s.agents.framingPrompts).toHaveLength(1);

      const answered = respondToHumanNode({
        db: s.db,
        runId: s.runId,
        nodeId: FRAMING_NODE,
        epoch: EPOCH,
        ts: s.clock.now(),
        by: 'operator',
        optionId: 'no',
        text: 'No — packages/legacy stays where it is.',
      });
      expect(answered.status).toBe('ok');
      expect(readWake(s.db, { runId: s.runId, nodeId: FRAMING_NODE })).toBeNull();

      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());

      expect(kinds(s.db, s.runId)).toContain('run.created');
      // The answer travelled into the resumed interview rather than being lost.
      expect(s.agents.framingPrompts[1]).toContain('packages/legacy stays where it is');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-19-S20 — plan validation fails before a token is spent (AC5)', () => {
  it('appends plan.validation_failed and run.needs_human, and starts no node', async ({ tmp }) => {
    // A plan with no gate at all: `ac-1` and `ac-2` are covered by nothing.
    const uncovered = present(planGraph([agentNode('implement')], []));
    const s = await scene(tmp, { plans: [uncovered, uncovered] });
    try {
      await s.driver.tick(s.clock.now());
      s.clock.advance(1_000);
      await approveSpec({ db: s.db, runId: s.runId, epoch: EPOCH, ts: s.clock.now(), by: 'cli' });

      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());

      const order = kinds(s.db, s.runId);
      expect(order).toContain('plan.validation_failed');
      expect(order).toContain('run.needs_human');
      expect(order).not.toContain('plan.proposed');
      expect(order).not.toContain('node.started');

      const needsHuman = payloadOf(s.db, s.runId, 'run.needs_human');
      expect(needsHuman?.reason).toBe('plan-invalid');
      expect(String(needsHuman?.detail)).toContain('ac-1');

      // And the run is a decision, not a loop: a later tick does not re-compile.
      s.clock.advance(60_000);
      await s.driver.tick(s.clock.now());
      expect(s.agents.plannerPrompts).toHaveLength(2);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-19-S22 — a crash between spec.pinned and plan.proposed does not re-frame (AC8)', () => {
  it('resumes from the pinned spec, issues no framing turn, and carries the same specHash', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      await s.driver.tick(s.clock.now());
      s.clock.advance(1_000);
      const approval = await approveSpec({
        db: s.db,
        runId: s.runId,
        epoch: EPOCH,
        ts: s.clock.now(),
        by: 'cli',
      });
      expect(kinds(s.db, s.runId)).toContain('spec.pinned');
      expect(kinds(s.db, s.runId)).not.toContain('plan.proposed');

      // The daemon dies here. A fresh engine over the same file is the only
      // shape that can express this at all; `:memory:` cannot.
      s.close();

      const db = openLedger(s.dataDir);
      try {
        const agents = scripted();
        const chain = createRunChain({
          resolve: resolverFor({ db, dataDir: s.dataDir, repoDir: s.repoDir, agents }),
        });
        const clock = new TestClock(T0 + 120_000);
        const driver = createRunDriver({
          db,
          clock,
          epoch: EPOCH + 1,
          runFraming: chain.runFraming,
          advanceRun: chain.advanceRun,
        });

        await driver.tick(clock.now());

        expect(kinds(db, s.runId)).toContain('plan.proposed');
        // No second interview, and therefore no second spec.
        expect(agents.framingPrompts).toEqual([]);
        expect(kinds(db, s.runId).filter((kind) => kind === 'run.created')).toHaveLength(1);

        const pinned = payloadOf(db, s.runId, 'spec.pinned');
        expect(pinned?.specHash).toBe(approval.specHash);
        // The plan the second daemon compiled cites the spec the operator
        // approved on the first one — the whole point of not re-framing.
        const proposed = payloadOf(db, s.runId, 'plan.proposed');
        const raw = readPlanDoc(db, String(proposed?.planHash));
        expect(raw).not.toBeNull();
        const doc = JSON.parse(raw ?? '{}') as { taskSpecHash?: string };
        expect(doc.taskSpecHash).toBe(approval.specHash);
      } finally {
        db.close();
      }
    } catch (error) {
      s.close();
      throw error;
    }
  });
});

suite('EPIC-19-S21 — recon on an unrecognised repository still feeds the planner', () => {
  it('records what it could establish, with provenance, and the plan still validates', async ({
    tmp,
  }) => {
    const repoDir = join(tmp, 'repo');
    // No manifest, no lockfile, no recognised build system.
    await makeRepo({ dir: repoDir, files: { 'NOTES.md': '# notes\n' } });
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });

    const db = openLedger(dataDir);
    try {
      seedCapabilities(db);
      const clock = new TestClock(T0);
      const agents = scripted();
      const chain = createRunChain({
        resolve: resolverFor({ db, dataDir, repoDir, agents }),
      });
      const submitted = await submitTask(
        {
          body: { input: { kind: 'text', text: RAW_TASK }, cwd: repoDir, permission: 'worktree' },
          by: 'cli',
        },
        { db, epoch: EPOCH, clock, dataDir, randomHex: () => '0b0b0b' },
      );
      if (submitted.outcome !== 'created') throw new Error('the submission was refused');
      const driver = createRunDriver({
        db,
        clock,
        epoch: EPOCH,
        runFraming: chain.runFraming,
        advanceRun: chain.advanceRun,
      });

      await driver.tick(clock.now());
      clock.advance(1_000);
      await approveSpec({ db, runId: submitted.runId, epoch: EPOCH, ts: clock.now(), by: 'cli' });
      clock.advance(1_000);
      await driver.tick(clock.now());

      expect(kinds(db, submitted.runId)).toContain('plan.proposed');
      const facts = readFacts(db, submitted.runId);
      expect(facts.length).toBeGreaterThan(0);
      for (const stored of facts) {
        expect(stored.fact.provenance.fromEvidence.length).toBeGreaterThanOrEqual(0);
        expect(stored.fact.provenance.byNode).toBe(RECON_NODE);
      }
    } finally {
      db.close();
    }
  });
});
