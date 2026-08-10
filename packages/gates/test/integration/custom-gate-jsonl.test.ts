/**
 * KAR-12.6 S39 — a custom producer parsed with `jsonl` and `$.violations`,
 * over a real child process.
 *
 * Verifies: EPIC-12-S39 · AC5
 */
import type { NodeId } from '@DeFlow/core';
import { it, makeRepo } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { loadGateDefinition } from '../../src/definition.ts';
import { GATE_TOOL_REASONS, runGate } from '../../src/run-gate.ts';
import { realClock } from './support/clock.ts';

const SPEC_HASH = `sha256-${'cd'.repeat(32)}`;
const GATE_NODE = 'gate-bundle-budget' as NodeId;
const PRODUCER = 'impl-1' as NodeId;
const NODE_BIN = process.execPath;

async function harness(tmp: string): Promise<{ worktree: string; dataDir: string }> {
  const worktree = join(tmp, 'worktree');
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  await makeRepo({ dir: worktree, files: { 'README.md': `# fixture\n` } });
  return { worktree, dataDir };
}

const bundleBudgetYaml = (script: string) => `id: bundle-budget
kind: deterministic
title: Bundle size budget
run: ${NODE_BIN} ${script}
cwd: worktree
timeout: 30s
effect: pure
expect:
  exitCode: 0
findings:
  parser: jsonl
  path: $.violations
satisfies: [ac-11]
`;

suite('a bundle-size budget gate (S39, happy path)', () => {
  it('each object under $.violations becomes a Finding, anchored and criteria-carrying', async ({
    tmp,
  }) => {
    const fixture = await harness(tmp);
    await mkdir(join(fixture.worktree, 'src'), { recursive: true });
    await writeFile(join(fixture.worktree, 'src', 'main.ts'), 'export const x = 1;\n');
    await writeFile(
      join(fixture.worktree, 'scripts.mjs'),
      "console.log(JSON.stringify({violations:[{file:'src/main.ts',line:1,rule:'budget/bundle-size',severity:'warning',message:'bundle is 214 KB, budget is 180 KB'}]}));\n" +
        'process.exit(0);\n',
    );

    const result = await runGate({
      definition: loadGateDefinition(
        '.DeFlow/gates/bundle-budget.yaml',
        bundleBudgetYaml('scripts.mjs'),
      ),
      worktree: fixture.worktree,
      repoRoot: fixture.worktree,
      node: GATE_NODE,
      evaluatedNode: PRODUCER,
      specHash: SPEC_HASH,
      dataDir: fixture.dataDir,
      clock: realClock,
      scrubbedEnv: [],
    });

    expect(result.outcome).toBe('pass');
    expect(result.reason).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe('src/main.ts');
    expect(result.findings[0]?.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.verdict.criteria).toEqual([{ id: 'ac-11', status: 'satisfied' }]);
  });
});

suite('a line that is not Finding-shaped (S39, failure branch)', () => {
  it('is needs-human with gate-output-unparseable, raw output attached, no partial findings', async ({
    tmp,
  }) => {
    const fixture = await harness(tmp);
    await writeFile(
      join(fixture.worktree, 'scripts.mjs'),
      "console.log(JSON.stringify({violations:[{line:1,message:'no file field'}]}));\n" +
        'process.exit(0);\n',
    );

    const result = await runGate({
      definition: loadGateDefinition(
        '.DeFlow/gates/bundle-budget.yaml',
        bundleBudgetYaml('scripts.mjs'),
      ),
      worktree: fixture.worktree,
      repoRoot: fixture.worktree,
      node: GATE_NODE,
      evaluatedNode: PRODUCER,
      specHash: SPEC_HASH,
      dataDir: fixture.dataDir,
      clock: realClock,
      scrubbedEnv: [],
    });

    expect(GATE_TOOL_REASONS).toContain('gate-output-unparseable');
    expect(result.outcome).toBe('needs-human');
    expect(result.reason).toBe('gate-output-unparseable');
    expect(result.findings).toEqual([]);
    expect(result.evidence).not.toBeNull();
    expect(result.evidence?.head).toContain('no file field');
  });
});
