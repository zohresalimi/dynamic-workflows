/**
 * KAR-12.3 AC6 — findings anchored to real blobs in a real git repository, and
 * what the diff surface does with them two attempts later.
 *
 * Integration because the two claims that matter are both about real bytes:
 * that DeFlow's computed object name is the one *git* would give the same
 * content — asserted against `git hash-object` in a real repository, not
 * against a second implementation of the same formula — and that a finding
 * produced by a real gate over a real worktree comes out anchored.
 *
 * Verifies: EPIC-12-S23 · AC6 · test plan #9
 */
import type { NodeId } from '@DeFlow/core';
import { it, makeRepo, sleep } from '@DeFlow/testkit';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, describe as suite } from 'vitest';
import { blobShaIn, gitBlobSha } from '../../src/anchor.ts';
import { loadGateDefinition } from '../../src/definition.ts';
import { projectFindings } from '../../src/projection.ts';
import { runGate } from '../../src/run-gate.ts';
import { realClock } from './support/clock.ts';

const run = promisify(execFile);

const SPEC_HASH = `sha256-${'ab'.repeat(32)}`;
const GATE_NODE = 'gate-lint' as NodeId;
const PRODUCER = 'impl-1' as NodeId;

/** Real git, with the machine's own configuration kept out of it. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

async function hashObject(dir: string, file: string): Promise<string> {
  const { stdout } = await run('git', ['hash-object', file], { cwd: dir, env: GIT_ENV });
  return stdout.trim();
}

/**
 * A gate that prints one `tsc`-shaped diagnostic about `src/app.ts`, whatever
 * the file contains. The gate under test here is the *anchor*, not the tool, so
 * the tool is a one-line script whose output is fixed and whose exit code is
 * not.
 */
const lintYaml = `id: lint
kind: deterministic
title: A fixed diagnostic about src/app.ts
run: >-
  node -e "console.log('src/app.ts(1,1): error TS2345: promise not awaited'); process.exit(1)"
cwd: worktree
timeout: 60s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-1]
severityFloor: error
`;

async function harness(tmp: string, content: string) {
  const worktree = join(tmp, 'worktree');
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  await makeRepo({ dir: worktree, files: { 'src/app.ts': content } });
  return { worktree, dataDir };
}

const runLint = (fixture: { worktree: string; dataDir: string }) =>
  runGate({
    definition: loadGateDefinition('.DeFlow/gates/lint.yaml', lintYaml),
    worktree: fixture.worktree,
    repoRoot: fixture.worktree,
    node: GATE_NODE,
    evaluatedNode: PRODUCER,
    specHash: SPEC_HASH,
    dataDir: fixture.dataDir,
    clock: realClock,
    scrubbedEnv: [],
  });

suite('the anchor is git’s own object name', () => {
  it('agrees with git hash-object on real content', async ({ tmp }) => {
    const dir = join(tmp, 'repo');
    await makeRepo({ dir, files: { 'a.ts': 'export const a = 1\n' } });

    expect(gitBlobSha('export const a = 1\n')).toBe(await hashObject(dir, 'a.ts'));
  });

  it('agrees on an empty file and on one with no trailing newline', async ({ tmp }) => {
    const dir = join(tmp, 'repo');
    await makeRepo({ dir, files: { 'empty.ts': '', 'bare.ts': 'x' } });

    expect(gitBlobSha('')).toBe(await hashObject(dir, 'empty.ts'));
    expect(gitBlobSha('x')).toBe(await hashObject(dir, 'bare.ts'));
  });

  it('changes when the content changes, which is the whole mechanism', async ({ tmp }) => {
    const dir = join(tmp, 'repo');
    await makeRepo({ dir, files: { 'a.ts': 'export const a = 1\n' } });
    const before = await hashObject(dir, 'a.ts');

    await writeFile(join(dir, 'a.ts'), '// a comment\nexport const a = 1\n');

    expect(await hashObject(dir, 'a.ts')).not.toBe(before);
    expect(blobShaIn(dir)('a.ts')).toBe(await hashObject(dir, 'a.ts'));
  });
});

suite('a real gate anchors every finding it reports (EPIC-12-S23, third scenario)', () => {
  it('stamps the blob of the file the tool complained about', async ({ tmp }) => {
    const content = 'export const a = 1\n';
    const fixture = await harness(tmp, content);

    const result = await runLint(fixture);

    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.blobSha).toBe(await hashObject(fixture.worktree, 'src/app.ts'));
    expect(result.verdict.findings[0]?.location).toEqual({
      file: 'src/app.ts',
      line: 1,
      blobSha: gitBlobSha(content),
    });
  });
});

suite('two attempts against a file edited between them (test plan #9)', () => {
  it('projects the earlier attempt’s finding as stale, with its attempt number', async ({
    tmp,
  }) => {
    const fixture = await harness(tmp, 'export const a = 1\n');

    const attemptTwo = await runLint(fixture);
    const blobAtTwo = attemptTwo.verdict.findings[0]?.location?.blobSha;

    // Attempt 3 inserts ten lines at the top of the file: every line number the
    // attempt-2 finding recorded now points somewhere else.
    await sleep(2);
    const shifted = `${'// header\n'.repeat(10)}export const a = 1\n`;
    await writeFile(join(fixture.worktree, 'src', 'app.ts'), shifted);
    const attemptThree = await runLint(fixture);
    const blobAtThree = attemptThree.verdict.findings[0]?.location?.blobSha;

    expect(blobAtThree).not.toBe(blobAtTwo);
    expect(blobAtThree).toBe(await hashObject(fixture.worktree, 'src/app.ts'));

    // Rendering the attempt-3 revision: the attempt-2 finding is only stale if
    // it is a *different* finding, which it is not here — the id is stable
    // across the edit, so the projection deduplicates to the newer measurement.
    const deduplicated = projectFindings(
      [
        { attempt: 2, verdict: attemptTwo.verdict },
        { attempt: 3, verdict: attemptThree.verdict },
      ],
      blobShaIn(fixture.worktree),
    );
    expect(deduplicated.length).toBe(1);
    expect(deduplicated[0]?.fromAttempt).toBe(3);
    expect(deduplicated[0]?.stale).toBe(false);

    // And a finding attempt 3 did *not* re-report — one the repair loop is
    // still carrying from attempt 2 — is drawn as stale, naming attempt 2.
    const carried = projectFindings(
      [{ attempt: 2, verdict: attemptTwo.verdict }],
      blobShaIn(fixture.worktree),
    );
    expect(carried[0]?.stale).toBe(true);
    expect(carried[0]?.fromAttempt).toBe(2);
    expect(carried[0]?.location?.line).toBe(1);
  });
});
