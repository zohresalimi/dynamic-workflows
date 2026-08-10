/**
 * KAR-12.5 AC4 — a fix node the daemon really runs, and the ordering read off
 * the branch it left behind.
 *
 * `repairOrdering` is pure and already tested against hand-made commit lists.
 * What this spec adds is the half that cannot be faked: a **real agent process**
 * over a real ACP pipe, writing real files through the daemon's own `fs` and
 * `terminal` services into a real `git worktree` on
 * `DeFlow/<runId>__<nodeId>` — and then a real `tsc` re-run at each commit it
 * made, which is the only way to tell *"the agent wrote the test first"* from
 * *"the agent said it did"*.
 *
 * The two scenarios are the two arms §7 cares about. The first is the repair
 * that behaved: test, then fix. The second is the one that looks like success —
 * a single commit that goes straight to green — and it is refused, because a
 * repair that cannot be expressed as a failing test is a signal, not a shortcut.
 *
 * Verifies: EPIC-12-S29 · AC4 · test plan #6, #7
 */
import { HandleSchema, type NodeId, NodeIdSchema, type RunId, RunIdSchema } from '@DeFlow/core';
import { loadGateDefinition } from '@DeFlow/gates';
import { blobHandle, openLedger, readEpoch, spillBytes } from '@DeFlow/ledger';
import { GIT_ENV, git, it, makeRepo, repoRoot } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { sqliteLedgerSink } from '../../src/exec/ledger-sink.ts';
import { runFixNode } from '../../src/gates/fix-node.ts';
import {
  acpFsHandlers,
  acpTerminalHandlers,
  buildChildEnv,
  createFsService,
  createTerminalService,
} from '../../src/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260810T140000Z_c0ffee');
const FIX: NodeId = NodeIdSchema.parse('fix-a13f0c2b91e4');
const PRODUCER: NodeId = NodeIdSchema.parse('impl-1');
const SPEC_HASH = `sha256-${'d'.repeat(64)}`;

const MOCK_AGENT_BIN = join(repoRoot, 'packages/mock-agent/bin/mock-agent.ts');
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'es2024',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      allowImportingTsExtensions: true,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src', 'test'],
  },
  null,
  2,
)}\n`;

/** The producer's bug: a day count that returns the date it was given. */
const BUGGY = 'export function daysUntil(target: Date): number {\n  return target;\n}\n';

const FIXED =
  'export function daysUntil(target: Date): number {\n' +
  '  return Math.round(target.getTime() / 86_400_000);\n}\n';

/** The regression test the fix node is required to write before the fix. */
const REGRESSION =
  "import { daysUntil } from '../src/date-picker.ts';\n\n" +
  'export const days: number = daysUntil(new Date());\n';

const TYPECHECK_YAML = `id: typecheck
kind: deterministic
title: TypeScript project check
run: ${TSC} -p tsconfig.json --noEmit --pretty false
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-1]
severityFloor: error
`;

/** One `terminal/create` + wait + release, as three scripted client calls. */
const shell = (command: string, args: readonly string[]) => [
  { type: 'clientCall', method: 'terminal/create', params: { command, args } },
  { type: 'clientCall', method: 'terminal/wait_for_exit', params: {} },
  { type: 'clientCall', method: 'terminal/release', params: {} },
];

const writeStep = (path: string, content: string) => ({
  type: 'clientCall',
  method: 'fs/write_text_file',
  params: { path, content },
});

interface Harness {
  readonly worktree: string;
  readonly dataDir: string;
  readonly baseSha: string;
  readonly branch: string;
}

/** A repository with the bug in it, and a worktree for the fix node on its own
 * branch — exactly what the workspace provisioner hands a node. */
async function harness(tmp: string): Promise<Harness> {
  const origin = join(tmp, 'repo');
  const worktree = join(tmp, 'wt', FIX);
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });

  await makeRepo({
    dir: origin,
    files: {
      'src/date-picker.ts': BUGGY,
      'tsconfig.json': TSCONFIG,
      'test/.keep': '',
    },
  });

  const branch = `DeFlow/${RUN}__${FIX}`;
  await git(origin, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  const baseSha = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  return { worktree, dataDir, baseSha, branch };
}

async function scenarioFile(tmp: string, name: string, steps: unknown[]): Promise<string> {
  const path = join(tmp, `${name}.json`);
  await writeFile(path, JSON.stringify({ name, steps, stopReason: 'end_turn' }));
  return path;
}

async function run(fixture: Harness, scenario: string) {
  const db = openLedger(fixture.dataDir);
  try {
    const epoch = readEpoch(db);
    const childEnv = buildChildEnv({
      base: { ...process.env, ...GIT_ENV },
      loginPath: process.env.PATH ?? '',
      tmpdir: fixture.dataDir,
      // `buildChildEnv` keeps only what §4.1 allows, so the fix node has to
      // **declare** the variables its own commands need. Without it the
      // agent's `git commit` inherits the developer's global config, which is
      // exactly the "passes locally" failure testkit's ./git.ts exists to
      // prevent.
      declared: Object.keys(GIT_ENV),
    }).env;

    return await runFixNode(
      {
        runId: RUN,
        nodeId: FIX,
        attempt: 0,
        provider: 'mock',
        permission: 'worktree',
        worktree: fixture.worktree,
        baseSha: fixture.baseSha,
        binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'b'.repeat(64) },
        argv: ['--seed', '42', '--scenario', scenario],
        prompt: 'repair finding a13f0c2b91e4',
        gate: loadGateDefinition('.DeFlow/gates/typecheck.yaml', TYPECHECK_YAML),
        specHash: SPEC_HASH,
        evaluatedNode: PRODUCER,
        declared: ['src/date-picker.ts', 'test/**'],
      },
      {
        clock: systemClock,
        dataDir: fixture.dataDir,
        ledger: sqliteLedgerSink({ db, runId: RUN, epoch, dataDir: fixture.dataDir }),
        captureEvidence: (text) =>
          HandleSchema.parse(
            blobHandle(
              spillBytes(
                fixture.dataDir,
                Buffer.from(typeof text === 'string' ? text : Buffer.from(text)),
                'text/plain',
              ).sha256,
            ),
          ),
        handlers: {
          ...acpFsHandlers(createFsService({ root: fixture.worktree })),
          ...acpTerminalHandlers(createTerminalService({ root: fixture.worktree, childEnv })),
        },
      },
    );
  } finally {
    db.close();
  }
}

suite('a fix node that wrote the failing test first (test plan #6)', () => {
  it('makes two real commits, and the gate fails at the first and passes at the second', async ({
    tmp,
  }) => {
    const fixture = await harness(tmp);
    const scenario = await scenarioFile(tmp, 'repair-in-order', [
      writeStep(join(fixture.worktree, 'test', 'days-until.test.ts'), REGRESSION),
      ...shell('git', ['add', '-A']),
      ...shell('git', ['commit', '-m', 'repair: reproduce a13f0c2b91e4']),
      writeStep(join(fixture.worktree, 'src', 'date-picker.ts'), FIXED),
      ...shell('git', ['add', '-A']),
      ...shell('git', ['commit', '-m', 'repair: return a day count']),
    ]);

    const outcome = await run(fixture, scenario);

    expect(outcome.status).toBe('repaired');
    if (outcome.status !== 'repaired') return;

    // Two commits, judged by a real compiler at each one. The first is the
    // demonstration: it is a test, and the gate says no at it.
    expect(outcome.commits).toHaveLength(2);
    expect(outcome.commits[0]?.paths).toEqual(['test/days-until.test.ts']);
    expect(outcome.commits[0]?.outcome).toBe('fail');
    expect(outcome.commits[1]?.paths).toEqual(['src/date-picker.ts']);
    expect(outcome.commits[1]?.outcome).toBe('pass');
    expect(outcome.ordering.testCommit).toBe(outcome.commits[0]?.sha);
    expect(outcome.ordering.fixCommit).toBe(outcome.commits[1]?.sha);
  });

  it('leaves the worktree on its own branch, at the tip it committed', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const scenario = await scenarioFile(tmp, 'repair-in-order', [
      writeStep(join(fixture.worktree, 'test', 'days-until.test.ts'), REGRESSION),
      ...shell('git', ['add', '-A']),
      ...shell('git', ['commit', '-m', 'repair: reproduce a13f0c2b91e4']),
      writeStep(join(fixture.worktree, 'src', 'date-picker.ts'), FIXED),
      ...shell('git', ['add', '-A']),
      ...shell('git', ['commit', '-m', 'repair: return a day count']),
    ]);

    const outcome = await run(fixture, scenario);
    if (outcome.status !== 'repaired') throw new Error(`expected a repair, got ${outcome.status}`);

    // The ordering check checks commits out; a node left detached at HEAD~1
    // would hand the re-run gate a tree with no fix in it, which is the stale
    // green §5.2 exists to prevent.
    expect((await git(fixture.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(
      fixture.branch,
    );
    expect((await git(fixture.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(
      outcome.ordering.fixCommit,
    );
  });
});

suite('a fix node that fixed the check instead of the code (test plan #11)', () => {
  it('fails on path scope before any commit is judged', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const scenario = await scenarioFile(tmp, 'repair-the-check', [
      writeStep(
        join(fixture.worktree, '.DeFlow', 'gates', 'typecheck.yaml'),
        TYPECHECK_YAML.replace('exitCode: 0', 'exitCode: 2'),
      ),
      ...shell('git', ['add', '-A']),
      ...shell('git', ['commit', '-m', 'repair: relax the gate']),
    ]);

    // A throw, not an outcome: §9.1's failure mode is an agent editing the
    // check, and a verdict formed in a run where the check was edited is a
    // verdict about nothing.
    await expect(run(fixture, scenario)).rejects.toThrow(/\.DeFlow\/gates/);
  });
});

suite('a fix node that skipped the test (test plan #7)', () => {
  it('records repair.no_failing_test rather than accepting a green branch', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const scenario = await scenarioFile(tmp, 'repair-shortcut', [
      writeStep(join(fixture.worktree, 'src', 'date-picker.ts'), FIXED),
      ...shell('git', ['add', '-A']),
      ...shell('git', ['commit', '-m', 'repair: return a day count']),
    ]);

    const outcome = await run(fixture, scenario);

    expect(outcome.status).toBe('unordered');
    if (outcome.status !== 'unordered') return;
    expect(outcome.ordering.code).toBe('repair.no_failing_test');
    // The branch is green. That is precisely the problem.
    expect(outcome.commits).toHaveLength(1);
    expect(outcome.commits[0]?.outcome).toBe('pass');
  });
});
