/**
 * KAR-10.5 — a recon node, end to end: a real repository, a real detached and
 * locked worktree, a real file-backed ledger, the real Ajv2020 validator over
 * the repository's emitted schemas and the real Tier-2 tokenizer.
 *
 * Integration rather than unit for the usual reason: every claim here is about
 * something real. *Is* the script key in the file on disk. *Does* the walk count
 * 47 files. *Does* the fact survive the blackboard projection and come back with
 * its provenance intact. A unit test of `deriveReconFacts` proves the rule
 * (`packages/core/src/recon.test.ts`); only this proves the rule is applied to
 * the repository DeFlow actually surveyed.
 *
 * The session is a port with a scripted queue, exactly as
 * ./framing-interview.test.ts scripts one. The half a scripted session cannot
 * prove — that `read` is enforced against a real agent process reaching back
 * into the client — is ./recon-isolation.test.ts.
 *
 * Verifies: EPIC-10-S24, EPIC-10-S25, EPIC-10-S27, EPIC-10-S28 · AC2, AC3,
 * AC4, AC5, AC6, AC7, AC8 · test plan #1, #2, #5, #6, #7, #8
 */
import type { Db, Handle, NodeId, RunId, StructuredOutput, TaskSpec } from '@DeFlow/core';
import {
  buildPlannerPacket,
  HandleSchema,
  NodeIdSchema,
  RECON_RETURN_MAX_TOKENS,
  RunIdSchema,
  TaskSpecSchema,
} from '@DeFlow/core';
import { blobHandle, getBlob, openLedger, readFacts, readRange, spillBytes } from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { WorkspaceManager } from '../../src/git/worktree-manager.ts';
import { type ReconAgent, type ReconOutcome, runReconNode } from '../../src/recon/recon.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

/** The repository's own emitted documents — the bytes `DeFlow init` copies. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ac1005');
const RECON: NodeId = NodeIdSchema.parse('recon');
const T0 = 1_754_380_800_000;
const EPOCH = 3;

const MANIFEST = `{
  "name": "ui",
  "private": true,
  "packageManager": "pnpm@11.18.0",
  "scripts": {
    "test": "vitest run",
    "build": "vite build"
  }
}
`;

const GATE_YAML = `id: typecheck
run: pnpm typecheck
expect: exit-zero
`;

/** 47 Vue SFCs under packages/ui, as EPIC-10-S24's background describes. */
function uiFiles(count = 47): Record<string, string> {
  const files: Record<string, string> = {};
  for (let at = 1; at <= count; at += 1) {
    files[`packages/ui/src/components/C${at}.vue`] = `<template><div>${at}</div></template>\n`;
  }
  return files;
}

const present = (value: unknown): StructuredOutput => ({ present: true, value });

const survey = (commands: Record<string, string>): StructuredOutput =>
  present({
    schemaId: 'DeFlow.reconsurvey.v1',
    toolchain: { language: 'typescript', packageManager: 'pnpm' },
    commands,
  });

/** A session that answers with the scripted returns in order, recording every
 * repair prompt it was sent. */
function scripted(...turns: readonly StructuredOutput[]): ReconAgent & {
  readonly repairs: string[];
  readonly prompts: string[];
} {
  const repairs: string[] = [];
  const prompts: string[] = [];
  let at = 0;
  const next = (): StructuredOutput => {
    const turn = turns[at];
    at += 1;
    if (turn === undefined) throw new Error('the recon session was asked for an unscripted turn');
    return turn;
  };
  return {
    repairs,
    prompts,
    open(prompt: string) {
      prompts.push(prompt);
      return Promise.resolve({
        session: {
          repair: (repairPrompt: string) => {
            repairs.push(repairPrompt);
            return Promise.resolve(next());
          },
        },
        turn: { structuredOutput: next() },
      });
    },
  };
}

interface Scene {
  readonly root: string;
  readonly repo: string;
  readonly db: Db;
  readonly manager: WorkspaceManager;
  readonly worktreeCalls: string[][];
  putSurvey(bytes: Uint8Array): Handle;
  close(): void;
}

async function scene(tmp: string, files: Readonly<Record<string, string>>): Promise<Scene> {
  const root = await realpath(tmp);
  const repo = join(root, 'repo');
  await makeRepo({ dir: repo, files });

  const wrapped = new Git(repo, { env: GIT_ENV });
  const worktreeCalls: string[][] = [];
  const db = openLedger(root);
  const manager = new WorkspaceManager({
    git: {
      run: (args, opts) => {
        if (args[0] === 'worktree') worktreeCalls.push([...args]);
        return wrapped.run(args, opts);
      },
    },
    db,
    clock: new TestClock(T0),
    epoch: EPOCH,
  });

  return {
    root,
    repo,
    db,
    manager,
    worktreeCalls,
    putSurvey: (bytes) =>
      HandleSchema.parse(
        blobHandle(spillBytes(root, Buffer.from(bytes), 'application/json').sha256),
      ),
    close: () => {
      db.close();
    },
  };
}

async function runRecon(
  s: Scene,
  agent: ReconAgent,
  scopePaths: readonly string[] = ['packages/ui'],
): Promise<ReconOutcome> {
  return runReconNode({
    db: s.db,
    runId: RUN,
    node: RECON,
    attempt: 0,
    epoch: EPOCH,
    ts: T0,
    provider: 'mock',
    model: 'mock-1',
    workspace: s.manager,
    worktree: { path: join(s.repo, '.DeFlow', 'wt', `${RUN}__${RECON}`), baseRef: 'main' },
    scopePaths,
    prompt: 'Survey this repository.',
    agent,
    schemas: loadSchemaDirectory(SCHEMAS_DIR),
    registry: loadSchemaDirectory(SCHEMAS_DIR),
    tokenizer: o200kTokenizer(),
    putSurvey: s.putSurvey,
    captureEvidence: (text) =>
      HandleSchema.parse(
        blobHandle(spillBytes(s.root, Buffer.from(text, 'utf8'), 'text/plain').sha256),
      ),
  });
}

const factsByKey = (db: Db) =>
  new Map(readFacts(db, RUN).map((stored) => [stored.fact.key, stored]));

const eventKinds = (db: Db): string[] =>
  readRange(db, RUN, 0, 500).events.map((event) => event.kind);

suite('EPIC-10-S24 — the survey lands as facts, not as a report (test plan #1)', () => {
  it('writes finding/* and scope/* facts with provenance and file evidence', async ({ tmp }) => {
    const s = await scene(tmp, {
      'package.json': MANIFEST,
      '.DeFlow/gates/typecheck.yaml': GATE_YAML,
      ...uiFiles(),
    });
    try {
      const outcome = await runRecon(
        s,
        scripted(survey({ test: 'pnpm test', build: 'pnpm build' })),
      );
      expect(outcome.outcome).toBe('completed');

      const written = eventKinds(s.db).filter((kind) => kind === 'fact.written');
      expect(written.length).toBeGreaterThanOrEqual(4);

      const facts = factsByKey(s.db);
      for (const key of [
        'finding/toolchain',
        'finding/test-command',
        'finding/build-command',
        'scope/touched-paths',
      ]) {
        expect(facts.has(key), key).toBe(true);
        const { provenance } = facts.get(key)?.fact as { provenance: Record<string, unknown> };
        expect(provenance.byNode).toBe(RECON);
        expect(provenance.byProvider).toBe('mock');
        expect(provenance.byModel).toBe('mock-1');
        expect(provenance.atEvent).toBeGreaterThan(0);
        expect(provenance.confidence).toBeDefined();
      }

      // AC2, AC5 — the test command is verified against the manifest and points
      // at the line the script key is really declared on.
      const test = facts.get('finding/test-command');
      expect(test?.fact.provenance.confidence).toBe('verified');
      expect(test?.fact.provenance.fromEvidence).toEqual(['file://package.json#L6-L6']);

      // AC3 — the discovered path set and its file count, which the patch
      // policy's blastRadiusFiles reads.
      const scope = facts.get('scope/touched-paths');
      expect(scope?.fact.kind).toBe('scope');
      expect(scope?.fact.value).toMatchObject({ paths: ['packages/ui'], fileCount: 47 });
    } finally {
      s.close();
    }
  });
});

suite('EPIC-10-S25 — a claimed command that does not exist (test plan #2)', () => {
  it('records it speculative, not verified, and gives it no evidence', async ({ tmp }) => {
    const s = await scene(tmp, {
      // No "test" script at all — only build.
      'package.json': '{\n  "name": "ui",\n  "scripts": {\n    "build": "vite build"\n  }\n}\n',
      ...uiFiles(3),
    });
    try {
      await runRecon(s, scripted(survey({ test: 'pnpm test:unit' })));

      const test = factsByKey(s.db).get('finding/test-command');
      expect(test?.fact.provenance.confidence).toBe('speculative');
      expect(test?.fact.provenance.confidence).not.toBe('verified');
      expect(test?.fact.provenance.fromEvidence).toEqual([]);
      expect(test?.fact.value).toMatchObject({ command: 'pnpm test:unit', script: null });
    } finally {
      s.close();
    }
  });
});

suite('a session that returns nothing usable', () => {
  it('fails the node and still keeps what DeFlow observed for itself', async ({ tmp }) => {
    const s = await scene(tmp, { 'package.json': MANIFEST, ...uiFiles(4) });
    try {
      // Missing `toolchain`, so Ajv refuses it before and after the repair.
      const unusable = present({ schemaId: 'DeFlow.reconsurvey.v1', commands: {} });
      const outcome = await runRecon(s, scripted(unusable, unusable));

      expect(outcome.outcome).toBe('failed');
      expect(eventKinds(s.db)).toContain('node.failed');

      // The manifest was read and the paths were counted whatever the model did.
      const facts = factsByKey(s.db);
      expect(facts.get('finding/test-command')?.fact.provenance.confidence).toBe('verified');
      expect(facts.get('scope/touched-paths')?.fact.value).toMatchObject({ fileCount: 4 });
      // And nothing was folded in from a document that never validated.
      expect(facts.get('finding/toolchain')?.fact.value).not.toHaveProperty('claimedLanguage');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-10-S25 — a repository with no manifest at all (test plan #8)', () => {
  it('states that detection failed at asserted, and fabricates no toolchain', async ({ tmp }) => {
    const s = await scene(tmp, { 'README.md': '# nothing but prose\n' });
    try {
      await runRecon(s, scripted(survey({ test: 'pnpm test', build: 'pnpm build' })), []);

      const facts = factsByKey(s.db);
      for (const key of ['finding/toolchain', 'finding/test-command', 'finding/build-command']) {
        const fact = facts.get(key);
        expect(fact?.fact.provenance.confidence, key).toBe('asserted');
        expect(fact?.fact.value, key).toMatchObject({ reconKind: 'detection-failed' });
      }
      // No fabricated command reached the ledger under any key.
      const serialised = JSON.stringify(readFacts(s.db, RUN));
      expect(serialised).not.toContain('pnpm test');
      expect(serialised).not.toContain('pnpm build');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-10-S27 — .DeFlow/gates/ in the repository (test plan #5)', () => {
  it('names each gate id with the file it was read from, and executes none', async ({ tmp }) => {
    const s = await scene(tmp, {
      'package.json': MANIFEST,
      '.DeFlow/gates/typecheck.yaml': GATE_YAML,
      '.DeFlow/gates/visual-regression.yaml': 'id: visual-regression\nrun: pnpm test:visual\n',
      ...uiFiles(2),
    });
    try {
      await runRecon(s, scripted(survey({ test: 'pnpm test' })));

      const gates = factsByKey(s.db).get('finding/repo-gates');
      expect(gates?.fact.provenance.confidence).toBe('verified');
      expect(gates?.fact.value).toMatchObject({
        gates: [
          { id: 'typecheck', path: '.DeFlow/gates/typecheck.yaml' },
          { id: 'visual-regression', path: '.DeFlow/gates/visual-regression.yaml' },
        ],
      });
      expect(gates?.fact.provenance.fromEvidence[0]).toMatch(
        /^file:\/\/\.DeFlow\/gates\/typecheck\.yaml#L1-L\d+$/,
      );

      // Read-only cataloguing: nothing ran, and no gate file was rewritten.
      expect(eventKinds(s.db)).not.toContain('gate.evaluated');
      expect(await readFile(join(s.repo, '.DeFlow/gates/typecheck.yaml'), 'utf8')).toBe(GATE_YAML);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-10-S28 — the survey is offloaded, never truncated (test plan #6)', () => {
  it('appends handoff.oversize, repairs exactly once, and keeps the full survey in the CAS', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { 'package.json': MANIFEST, ...uiFiles(200) });
    try {
      // The first return is a survey whose notes alone blow the 4,000-token
      // budget; the repair comes back inside it.
      const oversize = present({
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript', packageManager: 'pnpm' },
        commands: { test: 'pnpm test' },
        notes: Array.from(
          { length: 3000 },
          (_, at) => `packages/ui/src/components/C${at}.vue`,
        ).join(' '),
      });
      const agent = scripted(oversize, survey({ test: 'pnpm test' }));

      const outcome = await runRecon(s, agent);
      expect(outcome.outcome).toBe('completed');

      const oversizeEvents = readRange(s.db, RUN, 0, 500).events.filter(
        (event) => event.kind === 'handoff.oversize',
      );
      expect(oversizeEvents).toHaveLength(1);
      const payload = oversizeEvents[0]?.payload as { budget: number; actual: number };
      expect(payload.budget).toBe(RECON_RETURN_MAX_TOKENS);
      expect(payload.actual).toBeGreaterThan(RECON_RETURN_MAX_TOKENS);

      // Exactly one bounded repair. Never two.
      expect(agent.repairs).toHaveLength(1);
      if (outcome.outcome !== 'completed') return;
      expect(outcome.repairs).toBe(1);

      // The full survey is in the CAS, addressed by the handle every fact
      // derived from the walk points at — and it is whole, not a prefix.
      expect(outcome.survey).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);
      const stored = JSON.parse(Buffer.from(getBlob(s.root, outcome.survey)).toString('utf8')) as {
        files: string[];
      };
      expect(stored.files).toHaveLength(200);

      const scope = factsByKey(s.db).get('scope/touched-paths');
      expect(scope?.fact.value).toMatchObject({ fileCount: 200, survey: outcome.survey });
      // The fact body is a summary plus a handle: it never carries the listing.
      expect(JSON.stringify(scope?.fact.value)).not.toContain('C199.vue');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-10-S24, S28 — what the planner is handed (test plan #7)', () => {
  it('carries the facts and no recon transcript', async ({ tmp }) => {
    const s = await scene(tmp, {
      'package.json': MANIFEST,
      '.DeFlow/gates/typecheck.yaml': GATE_YAML,
      ...uiFiles(),
    });
    try {
      await runRecon(s, scripted(survey({ test: 'pnpm test', build: 'pnpm build' })));

      const spec: TaskSpec = TaskSpecSchema.parse({
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'Migrate every component under packages/ui to Vue 3.',
        scope: { included: ['packages/ui'] },
        nonGoals: ['Do not touch packages/legacy.'],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'pnpm test passes.' }],
        knownFailureModes: [],
        approvedBy: { at: '2026-08-07T10:15:00.000Z', via: 'ui' },
        specHash: `sha256-${'1'.repeat(64)}`,
      });

      const packet = await buildPlannerPacket({
        runId: RUN,
        nodeId: 'planner',
        attempt: 0,
        builtAtEvent: 40,
        target: { provider: 'mock', model: 'mock-1', maxContext: 200_000 },
        spec,
        facts: readFacts(s.db, RUN).map((stored) => ({
          key: stored.fact.key,
          confidence: stored.fact.provenance.confidence,
          value: stored.fact.value,
          fromEvidence: [...stored.fact.provenance.fromEvidence],
          sourceEvent: stored.writtenSeq,
        })),
        // KAR-11.1's third planner input. Empty here on purpose: this spec is
        // about what recon leaves behind, and an empty list is the honest
        // answer for a scene that never probed a binary.
        capabilities: [],
      });

      const keys = packet.segments
        .filter((segment) => segment.kind === 'fact')
        .map((segment) => segment.id);
      expect(keys).toContain('fact-finding-test-command');
      expect(keys).toContain('fact-scope-touched-paths');

      // AC7 — no transcript, in any form.
      expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
      expect(packet.totals.byKind['history.summary']).toBe(0);
      // The trailing `fact` is KAR-11.1's capability-list segment: one per
      // packet, always present, and empty-but-stated for a scene with no
      // probed rows (`renderCapabilitySegmentText`).
      expect(packet.segments.map((segment) => segment.kind)).toMatchInlineSnapshot(`
        [
          "pinned.spec",
          "pinned.spec",
          "pinned.constraints",
          "fact",
          "fact",
          "fact",
          "fact",
          "fact",
          "fact",
        ]
      `);
    } finally {
      s.close();
    }
  });
});

/** A recon run leaves the repository's own tree untouched — the survey happened
 * in the worktree, and the worktree is gone. */
suite('the worktree is cleaned up', () => {
  it('removes the recon worktree once the facts are written', async ({ tmp }) => {
    const s = await scene(tmp, { 'package.json': MANIFEST, ...uiFiles(2) });
    try {
      await runRecon(s, scripted(survey({ test: 'pnpm test' })));
      expect(eventKinds(s.db)).toContain('workspace.worktree_removed');
      await expect(stat(join(s.repo, '.DeFlow', 'wt', `${RUN}__${RECON}`))).rejects.toThrow();
    } finally {
      s.close();
    }
  });
});
