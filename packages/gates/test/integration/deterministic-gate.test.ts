/**
 * KAR-12.1 test plan #7, #8, #9 — the deterministic runner against real
 * processes in a real worktree.
 *
 * Nothing here mocks `spawn`. The whole story is on the other side of that
 * boundary: argv construction, the process group, the timeout, the exit-code
 * comparison and the parse of what the tool actually printed.
 *
 * Verifies: EPIC-12-S1, EPIC-12-S6, EPIC-12-S7 (second scenario) · AC6, AC7,
 * AC8
 */

import { liveGroupRows } from '@DeFlow/adapters';
import type { NodeId } from '@DeFlow/core';
import { it, makeRepo, repoRoot, sleep, TestClock } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { loadGateDefinition } from '../../src/definition.ts';
import { GATE_TOOL_REASONS, type GateRun, runGate } from '../../src/run-gate.ts';
import { realClock } from './support/clock.ts';

const SPEC_HASH = `sha256-${'ab'.repeat(32)}`;

const GATE_NODE = 'gate-typecheck' as NodeId;
const PRODUCER = 'impl-1' as NodeId;

/** The workspace's own tsc, resolved at run time — never a committed path. */
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

interface Harness {
  readonly worktree: string;
  readonly dataDir: string;
}

async function harness(tmp: string): Promise<Harness> {
  const worktree = join(tmp, 'worktree');
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  await makeRepo({ dir: worktree, files: { 'README.md': '# gate fixture\n' } });
  return { worktree, dataDir };
}

const definitionFor = (body: string) => loadGateDefinition('.DeFlow/gates/typecheck.yaml', body);

async function run(
  harnessValue: Harness,
  definitionYaml: string,
  options: { readonly clock?: TestClock; readonly onSpawn?: (pid: number) => void } = {},
): Promise<GateRun> {
  return runGate({
    definition: definitionFor(definitionYaml),
    worktree: harnessValue.worktree,
    repoRoot: harnessValue.worktree,
    node: GATE_NODE,
    evaluatedNode: PRODUCER,
    specHash: SPEC_HASH,
    dataDir: harnessValue.dataDir,
    clock: options.clock ?? realClock,
    scrubbedEnv: [],
    ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
  });
}

const typecheckYaml = (run_: string, extra = '') => `id: typecheck
kind: deterministic
title: TypeScript project check
run: ${run_}
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-3, ac-7]
severityFloor: error
${extra}`;

suite('a real tsc over a real type error (test plan #7)', () => {
  it('fails the gate and anchors its findings to the real file', async ({ tmp }) => {
    const fixture = await harness(tmp);
    await mkdir(join(fixture.worktree, 'src'), { recursive: true });
    await writeFile(
      join(fixture.worktree, 'src', 'app.ts'),
      'export function greet(name: string): string {\n  return name;\n}\nexport const n: number = greet("x");\n',
    );
    await writeFile(
      join(fixture.worktree, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'es2024', module: 'nodenext', strict: true, noEmit: true },
        include: ['src'],
      }),
    );

    const result = await run(
      fixture,
      typecheckYaml(`${TSC} -p tsconfig.json --noEmit --pretty false`),
    );

    expect(result.outcome).toBe('fail');
    expect(result.reason).toBeNull();
    expect(result.exitCode).not.toBe(0);
    expect(result.findings.length).toBeGreaterThan(0);

    const [first] = result.findings;
    expect(first?.file).toBe('src/app.ts');
    expect(first?.range.startLine).toBe(4);
    expect(first?.rule).toMatch(/^ts\d+$/);
    expect(first?.severity).toBe('error');
    expect(first?.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('passes, and produces a verdict of the documented shape (S1)', async ({ tmp }) => {
    const fixture = await harness(tmp);
    await mkdir(join(fixture.worktree, 'src'), { recursive: true });
    await writeFile(join(fixture.worktree, 'src', 'app.ts'), 'export const n: number = 1;\n');
    await writeFile(
      join(fixture.worktree, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'es2024', module: 'nodenext', strict: true, noEmit: true },
        include: ['src'],
      }),
    );

    const result = await run(
      fixture,
      typecheckYaml(`${TSC} -p tsconfig.json --noEmit --pretty false`),
    );

    expect(result.outcome).toBe('pass');
    expect(result.findings).toEqual([]);
    expect(result.verdict.gate).toBe('typecheck');
    expect(result.verdict.outcome).toBe('pass');
    expect(result.verdict.evaluatedNode).toBe(PRODUCER);
    expect(result.verdict.by.node).toBe(GATE_NODE);
    // Every criterion the definition claims to speak to gets a status.
    expect(result.verdict.criteria.map((entry) => entry.id)).toEqual(['ac-3', 'ac-7']);
    expect(result.verdict.criteria.every((entry) => entry.status === 'satisfied')).toBe(true);
    // The contract it was judged against, on the verdict itself.
    expect(result.verdict.specHash).toBe(SPEC_HASH);
    // `cost.durationMs` lands on the verdict document in KAR-12.3 (v2 is
    // frozen append-only); the runner already measures it.
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

suite('expect.exitCode is compared as a value against a real process (AC6)', () => {
  it('treats exit 1 as a pass when the definition expects 1', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const yaml = typecheckYaml('node -e "process.exit(1)"').replace('exitCode: 0', 'exitCode: 1');
    const result = await run(fixture, yaml.replace('parser: tsc', 'parser: none'));
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBe('pass');
  });
});

suite('a gate whose own tooling failed (test plan #8, S6)', () => {
  it('returns needs-human, not fail, when the binary does not exist', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const result = await run(
      fixture,
      typecheckYaml('tsc-that-does-not-exist -p tsconfig.json --noEmit'),
    );

    expect(result.outcome).toBe('needs-human');
    expect(result.reason).toBe('gate-tool-missing');
    expect(result.findings).toEqual([]);
    expect(result.verdict.outcome).toBe('needs-human');
    // A criterion a gate could not judge is unverifiable, never unsatisfied.
    expect(result.verdict.criteria.every((entry) => entry.status === 'unverifiable')).toBe(true);
  });

  it('returns needs-human when a non-zero exit produced no parseable output', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const result = await run(fixture, typecheckYaml('node -e "process.exit(7)"'));

    expect(result.outcome).toBe('needs-human');
    expect(result.reason).toBe('gate-no-output');
    expect(result.findings).toEqual([]);
  });

  it('names only the three documented reasons', () => {
    expect([...GATE_TOOL_REASONS]).toEqual(['gate-tool-missing', 'gate-timeout', 'gate-no-output']);
  });
});

suite('the timeout kills the process group, not just the child (test plan #9, S6)', () => {
  it('returns needs-human and leaves nothing alive in the group', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const clock = new TestClock(1_754_313_093_000);
    let pid: number | null = null;

    const yaml = typecheckYaml(`bash -c 'sleep 300 & sleep 300 & sleep 300; wait'`).replace(
      'timeout: 300s',
      'timeout: 5s',
    );

    const running = run(fixture, yaml, {
      clock,
      onSpawn: (spawned) => {
        pid = spawned;
      },
    });

    // Real waiting, never fake timers: the child is alive.
    for (let attempt = 0; attempt < 200 && pid === null; attempt += 1) await sleep(10);
    expect(pid).not.toBeNull();
    const pgid = pid as unknown as number;
    // The grandchildren really are in the group before it is signalled.
    for (let attempt = 0; attempt < 200 && liveGroupRows(pgid).length < 2; attempt += 1) {
      await sleep(10);
    }
    expect(liveGroupRows(pgid).length).toBeGreaterThanOrEqual(2);

    let settled = false;
    const done = running.then((value) => {
      settled = true;
      return value;
    });
    // Releases the timeout, then the SIGTERM → SIGKILL grace, then the drain
    // window — each on the injected clock rather than in real seconds.
    for (let step = 0; step < 200 && !settled; step += 1) {
      await clock.advance(250);
      await sleep(5);
    }

    const result = await done;
    expect(result.outcome).toBe('needs-human');
    expect(result.reason).toBe('gate-timeout');
    // `liveGroupRows` excludes Z-state processes: after a successful group
    // SIGKILL, `ps` still lists the grandchildren as zombies with ppid=1.
    expect(result.survivors).toEqual([]);
    expect(liveGroupRows(pgid)).toEqual([]);
  }, 20_000);
});

suite('parser "none" still produces a verdict (S7, second scenario)', () => {
  it('fails on the exit code with no findings, and attaches the full stdout', async ({ tmp }) => {
    const fixture = await harness(tmp);
    const yaml = typecheckYaml(
      'node -e "process.stdout.write(`a wall of output\\n`); process.exit(1)"',
    ).replace('parser: tsc', 'parser: none');

    const result = await run(fixture, yaml);

    expect(result.outcome).toBe('fail');
    expect(result.findings).toEqual([]);
    expect(result.evidence?.handle).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);
    expect(result.evidence?.head).toContain('a wall of output');
  });
});
