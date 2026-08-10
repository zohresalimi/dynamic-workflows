/**
 * KAR-12.1 — the daemon-side gate-node execution path.
 *
 * `@DeFlow/gates` owns *what a gate says*; this is the layer that makes a gate
 * a **node of a run**: one attempt, journalled through the same effect journal
 * every other side effect goes through, with `node.started`, `gate.evaluated`
 * and `node.completed` landing in the ledger the scheduler reads back.
 *
 * Everything here is real — a real repository, a real `tsc` child process with
 * a real type error in front of it, a real file-backed ledger — because the
 * claim under test is that the runner and the journal compose. A gate is a
 * `shell` effect with `classification: 'pure'`, which is not a detail: §2 makes
 * `effect: pure` a load error to violate precisely so that re-running a gate to
 * confirm a fix is always safe, and the journal's memoisation is what stops one
 * *attempt* paying for the same run twice.
 *
 * Verifies: EPIC-12-S1, EPIC-12-S2, EPIC-12-S10 · AC2, AC11
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { loadGateDefinition } from '@DeFlow/gates';
import { appendEvents, openLedger, readEffect, readRange } from '@DeFlow/ledger';
import { it, makeRepo, repoRoot, TestClock } from '@DeFlow/testkit';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { expect, describe as suite } from 'vitest';
import { createEffectRunner } from '../../src/effects/durable.ts';
import { runGateNode } from '../../src/gates/run-gate-node.ts';

const RUN: RunId = RunIdSchema.parse('run_20260809T101500Z_4d1b7a');
const GATE_NODE: NodeId = NodeIdSchema.parse('gate-typecheck');
const PRODUCER: NodeId = NodeIdSchema.parse('impl-1');
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const NOW = 1_754_310_000_000;
const EPOCH = 3;

/** The workspace's own compiler, resolved at run time — never a committed
 * absolute path (nothing under a home directory may reach origin). */
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

const gateYaml = (command: string, id = 'typecheck') => `id: ${id}
kind: deterministic
title: TypeScript project check
run: ${command}
cwd: worktree
timeout: 120s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: ${id === 'typecheck' ? 'tsc' : 'none'}
satisfies: [ac-1]
severityFloor: error
`;

interface Fixture {
  readonly worktree: string;
  readonly dataDir: string;
}

/** A worktree holding one real type error, and a data directory beside it. */
async function fixture(tmp: string, source: string): Promise<Fixture> {
  const worktree = join(tmp, 'worktree');
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  await makeRepo({ dir: worktree });
  await mkdir(join(worktree, 'src'), { recursive: true });
  await writeFile(join(worktree, 'src', 'app.ts'), source);
  await writeFile(
    join(worktree, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'es2024', module: 'nodenext', strict: true, noEmit: true },
      include: ['src'],
    }),
  );
  return { worktree, dataDir };
}

/** The three events the run must already carry for the fold to make sense. */
function seed(dataDir: string): void {
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      {
        runId: RUN,
        ts: NOW,
        kind: 'run.started',
        v: 1,
        epoch: EPOCH,
        payload: { planHash: PLAN_HASH },
      },
    ]);
  } finally {
    db.close();
  }
}

const kindsOf = (dataDir: string): string[] => {
  const db = openLedger(dataDir);
  try {
    return readRange(db, RUN, 0, 500).events.map((event) => event.kind);
  } finally {
    db.close();
  }
};

const eventsOf = (dataDir: string, kind: string) => {
  const db = openLedger(dataDir);
  try {
    return readRange(db, RUN, 0, 500).events.filter((event) => event.kind === kind);
  } finally {
    db.close();
  }
};

suite('one gate node, one attempt (S1)', () => {
  it('appends node.started, gate.evaluated and node.completed for a real failing tsc', async ({
    tmp,
  }) => {
    const { worktree, dataDir } = await fixture(tmp, 'export const n: number = "not a number";\n');
    seed(dataDir);
    const db = openLedger(dataDir);
    const clock = new TestClock(NOW);

    try {
      const outcome = await runGateNode(
        {
          runId: RUN,
          nodeId: GATE_NODE,
          attempt: 0,
          evaluatedNode: PRODUCER,
          definition: loadGateDefinition(
            '.DeFlow/gates/typecheck.yaml',
            gateYaml(`${TSC} -p tsconfig.json --noEmit --pretty false`),
          ),
          worktree,
          repoRoot: worktree,
          specHash: SPEC_HASH,
        },
        {
          db,
          clock,
          epoch: EPOCH,
          dataDir,
          daemonStartedAt: NOW,
          effects: createEffectRunner({ db, clock, daemonStartedAt: NOW, epoch: EPOCH }),
          scrubbedEnv: [],
        },
      );

      expect(outcome.status).toBe('completed');
      if (outcome.status !== 'completed') return;
      expect(outcome.run.outcome).toBe('fail');
      expect(outcome.verdict.outcome).toBe('fail');
      expect(outcome.verdict.findings.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    // The ledger, in the order the scheduler will read it back.
    expect(kindsOf(dataDir)).toEqual([
      'run.started',
      'node.started',
      'effect.started',
      // The journal closes its own row before the caller says what the result
      // means: `effect.completed` is "the command ran and its output is
      // recorded", `gate.evaluated` is "and here is what it implies".
      'effect.completed',
      'gate.evaluated',
      'node.completed',
    ]);

    const [evaluated] = eventsOf(dataDir, 'gate.evaluated');
    expect((evaluated?.payload as { gate: string }).gate).toBe('typecheck');
    expect((evaluated?.payload as { node: string }).node).toBe(PRODUCER);
    expect((evaluated?.payload as { verdict: { outcome: string } }).verdict.outcome).toBe('fail');

    // A deterministic gate spends no money. AC2's zero-delta assertion has to
    // be able to rest on this being a *fact about the result*, not a hope.
    const [completed] = eventsOf(dataDir, 'node.completed');
    const result = (completed?.payload as { result: { costUsd: number; output: unknown } }).result;
    expect(result.costUsd).toBe(0);
    expect(kindsOf(dataDir)).not.toContain('budget.consumed');
  });
});

suite('the gate is a pure shell effect in the journal (AC3, EPIC-06-S12)', () => {
  it('performs the command once per ikey, and records the row done', async ({ tmp }) => {
    const { worktree, dataDir } = await fixture(tmp, 'export const n: number = 1;\n');
    seed(dataDir);
    const log = join(tmp, 'ran.log');
    const script = join(tmp, 'counting-gate.sh');
    await writeFile(script, `#!/bin/sh\necho ran >> "${log}"\nexit 0\n`);
    await chmod(script, 0o755);

    const db = openLedger(dataDir);
    const clock = new TestClock(NOW);
    const effects = createEffectRunner({ db, clock, daemonStartedAt: NOW, epoch: EPOCH });
    const request = {
      runId: RUN,
      nodeId: GATE_NODE,
      attempt: 0,
      evaluatedNode: PRODUCER,
      definition: loadGateDefinition('.DeFlow/gates/counting.yaml', gateYaml(script, 'counting')),
      worktree,
      repoRoot: worktree,
      specHash: SPEC_HASH,
    } as const;
    const ports = {
      db,
      clock,
      epoch: EPOCH,
      dataDir,
      daemonStartedAt: NOW,
      effects,
      scrubbedEnv: [],
    } as const;

    try {
      const first = await runGateNode(request, ports);
      // The same attempt, re-entered — a resume after a crash between the
      // command finishing and the daemon dying.
      const second = await runGateNode({ ...request, ordinal: 0 }, ports);

      expect(first.status).toBe('completed');
      expect(second.status).toBe('completed');
      expect(readEffect(db, `${RUN}/${GATE_NODE}/0/0`)?.state).toBe('done');
    } finally {
      db.close();
    }

    // The command itself — not the journal — is asked whether it ran twice.
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});

suite('a gate is not a licence (AC11, S10)', () => {
  it('fails the node before spawn and writes no verdict', async ({ tmp }) => {
    const { worktree, dataDir } = await fixture(tmp, 'export const n: number = 1;\n');
    seed(dataDir);
    const binDir = join(tmp, 'bin');
    const marker = join(tmp, 'terraform-ran');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'terraform'), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    await chmod(join(binDir, 'terraform'), 0o755);

    const db = openLedger(dataDir);
    const clock = new TestClock(NOW);
    try {
      const outcome = await runGateNode(
        {
          runId: RUN,
          nodeId: GATE_NODE,
          attempt: 0,
          evaluatedNode: PRODUCER,
          definition: loadGateDefinition(
            '.DeFlow/gates/migrate.yaml',
            gateYaml('terraform apply -auto-approve', 'migrate'),
          ),
          worktree,
          repoRoot: worktree,
          specHash: SPEC_HASH,
        },
        {
          db,
          clock,
          epoch: EPOCH,
          dataDir,
          daemonStartedAt: NOW,
          effects: createEffectRunner({ db, clock, daemonStartedAt: NOW, epoch: EPOCH }),
          scrubbedEnv: [],
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        },
      );

      expect(outcome.status).toBe('failed');
      if (outcome.status !== 'failed') return;
      expect(outcome.failure.reason).toBe('safety.execution-boundary');
    } finally {
      db.close();
    }

    expect(kindsOf(dataDir)).not.toContain('gate.evaluated');
    expect(kindsOf(dataDir)).toContain('node.failed');
    // The claim is "before spawn", so the binary is asked.
    const ran = await readFile(marker, 'utf8').then(
      () => true,
      () => false,
    );
    expect(ran).toBe(false);
  });
});
