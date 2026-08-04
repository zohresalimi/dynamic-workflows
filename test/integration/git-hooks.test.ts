/**
 * KAR-01.6 — the pre-commit hook, run for real.
 *
 * A real `git init` in a real tmpdir, the repo's real `lefthook.yml`,
 * `biome.json` and `.oxlintrc.json`, the real lefthook binary installed into
 * `.git/hooks`, and real `git commit` invocations. Nothing here is mocked,
 * because everything that can go wrong with a git hook goes wrong in the
 * plumbing: a glob that matches nothing, a `stage_fixed` that rewrites the
 * working tree but not the index, a hook that is installed but not executable.
 *
 * `node_modules` is symlinked from the workspace root rather than installed, so
 * `pnpm biome` and `pnpm oxlint` inside the scratch repo resolve to the same
 * binaries the real hook uses.
 *
 * Verifies: EPIC-01-S20 (scenarios 1, 2 and 3), EPIC-01-S21 (scenario 1) ·
 * AC3, AC4; test plan #1, #2, #3
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { readJson, repoRoot } from '../support/workspace.ts';

const LEFTHOOK = join(repoRoot, 'node_modules/.bin/lefthook');

/** The hermetic git environment every git fixture in this repo uses. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'DeFlow Test',
  GIT_AUTHOR_EMAIL: 'test@deflow.invalid',
  GIT_COMMITTER_NAME: 'DeFlow Test',
  GIT_COMMITTER_EMAIL: 'test@deflow.invalid',
} as const;

interface Run {
  readonly code: number;
  readonly output: string;
}

let dir: string;

function run(bin: string, args: readonly string[], cwd = dir): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1),
          output: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

const git = (...args: string[]): Promise<Run> => run('git', args);

/** A formatted file the format job has nothing to do to. */
const CLEAN = 'export const answer = 42;\n';

/** Misformatted, but not a lint error: the format job must fix and re-stage it. */
const MISFORMATTED = "export  const   greeting   =    'hello'\n";

/** A floating promise: the type-aware rule set must reject it. */
const FLOATING =
  'export async function work(): Promise<void> {\n' +
  '  await Promise.resolve();\n' +
  '}\n' +
  '\n' +
  'export function start(): void {\n' +
  '  work();\n' +
  '}\n';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'DeFlow-git-hooks-'));

  // The real configuration, not a fixture of it — a hook that passes against a
  // simplified copy of biome.json has tested the copy.
  // .gitignore is in this list for a reason beyond faithfulness: node_modules
  // below is a symlink, and both oxlint's and Biome's directory walkers will
  // descend into it — a symlink is not the `node_modules` directory their
  // built-in defaults skip. `vcs.useIgnoreFile` in biome.json and oxlint's
  // .gitignore support are what stop the whole workspace being linted, twice,
  // through the link.
  for (const file of ['lefthook.yml', 'biome.json', '.oxlintrc.json', '.gitignore']) {
    copyFileSync(join(repoRoot, file), join(dir, file));
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'scratch',
        private: true,
        type: 'module',
        // The real root's script, so the pre-push job below runs the real
        // command rather than a hopeful approximation of it.
        scripts: { lint: readJson('package.json').scripts?.lint },
      },
      null,
      2,
    )}\n`,
  );
  // A harness artefact, not a copy of anything: this scratch repo has a
  // package.json and a node_modules symlinked from somewhere else, so pnpm's
  // pre-run dependency check compares them against a lockfile that does not
  // exist here and tries to install. Switching it off is what makes the hook
  // under test the thing being measured. The real repository keeps the check
  // on, which is why the budget measurement below runs there instead.
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\nverifyDepsBeforeRun: false\n');
  // --type-aware needs a type graph, and a type graph needs a tsconfig.
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
      },
    })}\n`,
  );

  await git('init', '--initial-branch=main');
  // An initial commit, so "git commit" is never the root commit special case.
  writeFileSync(join(dir, 'seed.ts'), CLEAN);
  await git('add', 'seed.ts', 'package.json');
  await git('commit', '--no-verify', '-m', 'seed');

  const installed = await run(LEFTHOOK, ['install']);
  expect(installed.code, installed.output).toBe(0);
}, 60_000);

afterEach(() => {
  if (process.env.DeFlow_KEEP_TMP === undefined) rmSync(dir, { recursive: true, force: true });
});

suite('formatting is fixed and re-staged rather than rejected (test plan #1)', () => {
  it('rewrites a misformatted .ts file and commits the formatted content', async () => {
    writeFileSync(join(dir, 'messy.ts'), MISFORMATTED);
    await git('add', 'messy.ts');

    const commit = await git('commit', '-m', 'add messy.ts');

    expect(commit.code, commit.output).toBe(0);
    // The working tree was rewritten...
    expect(readFileSync(join(dir, 'messy.ts'), 'utf8')).toBe("export const greeting = 'hello';\n");
    // ...and so was the index, which is the half `stage_fixed: true` buys and
    // the half that is invisible without asserting on the commit itself. If
    // only the working tree were rewritten, this commit would carry the
    // unformatted bytes and CI's "biome ci ." would fail on it.
    const committed = await git('show', 'HEAD:messy.ts');
    expect(committed.output).toContain("export const greeting = 'hello';");
    // And nothing tracked is left modified: the rewrite is entirely inside the
    // commit rather than half in it and half in the working tree.
    const dirty = await git('diff', '--name-only');
    expect(dirty.output.trim()).toBe('');
  });
});

suite('the floating-promise net (AC4, EPIC-01-S20 scenario 1, test plan #2)', () => {
  // AC4 asks for a floating promise to be rejected at *commit* time by oxlint,
  // while AC1 and EPIC-01-S20's own fourth scenario forbid `--type-aware` in
  // the pre-commit lint job. Those cannot both hold, and the reason is a fact
  // about oxlint rather than a preference: every one of the six correctness
  // rules .oxlintrc.json turns on — `typescript/no-floating-promises` included
  // — lives in the type-aware engine, which only runs behind that flag. The
  // first test is the measurement that settles it; the second is where the net
  // sits as a result — pre-push, still before the code reaches a branch.
  //
  // Both are asserted, so the arrangement is falsifiable in both directions. If
  // oxlint ever reports this rule without a type graph, the first test fails
  // and the job moves back down to pre-commit, where AC4 wanted it.
  it('pre-commit alone does not catch it, because the rule is type-aware', async () => {
    writeFileSync(join(dir, 'floating.ts'), FLOATING);
    await git('add', 'floating.ts');

    const commit = await git('commit', '-m', 'add floating.ts');

    expect(commit.code, commit.output).toBe(0);
    expect(commit.output).not.toContain('no-floating-promises');
  });

  it('the pre-push lint job rejects it, naming the oxlint rule', async () => {
    writeFileSync(join(dir, 'floating.ts'), FLOATING);
    await git('add', 'floating.ts');
    await git('commit', '-m', 'add floating.ts');

    const push = await run(LEFTHOOK, ['run', 'pre-push', '--job', 'lint', '--no-tty']);

    expect(push.code).not.toBe(0);
    expect(push.output).toContain('no-floating-promises');
  });
});

suite('the hook only looks at staged files (EPIC-01-S20 scenario 3)', () => {
  it('commits a clean staged change while an unstaged file holds a lint error', async () => {
    writeFileSync(join(dir, 'unrelated.ts'), 'const  x  =  1\nexport  default  x\n');
    writeFileSync(join(dir, 'clean.ts'), CLEAN);
    await git('add', 'clean.ts');

    const commit = await git('commit', '-m', 'add clean.ts');

    expect(commit.code, commit.output).toBe(0);
    // The unstaged file was neither formatted nor complained about — it is CI's
    // problem, not this commit's.
    expect(readFileSync(join(dir, 'unrelated.ts'), 'utf8')).toBe(
      'const  x  =  1\nexport  default  x\n',
    );
  });
});

suite('a commit the linter has nothing to say about still commits', () => {
  // Found by the hook rejecting the very commit that added it. `.oxlintrc.json`
  // ignores every `test/` directory, and oxlint exits 1 with "No files found to
  // lint" when its ignore patterns eat the whole argument list — so a
  // test-only commit, which in a TDD project is most of them, failed a hook it
  // had no business failing. That is the precise shape of the failure this
  // story exists to prevent: a hook you cannot trust is a hook you bypass, and
  // the second time you type "--no-verify" it has stopped existing.
  it('a staged file inside an oxlint-ignored path does not fail the hook', async () => {
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test/helper.ts'), CLEAN);
    await git('add', 'test/helper.ts');

    const commit = await git('commit', '-m', 'add a test helper');

    expect(commit.code, commit.output).toBe(0);
    expect(commit.output).not.toContain('No files found to lint');
  });
});

suite('the two-second budget (AC3, test plan #3, EPIC-01-S21 scenario 1)', () => {
  const BUDGET_MS = 2000;
  const RUNS = 5;
  const FILES = 20;

  // Measured in the *real* repository rather than the scratch one, because the
  // number this defends is the one a developer waits for: real dependency
  // counts, real pnpm startup, real config. `--force --no-stage-fixed` over an
  // explicit file list is a full run of both jobs that cannot touch the index,
  // and the assertion below proves it changed nothing on disk either.
  it('the median wall-clock time over 20 staged files stays under 2 s', async () => {
    const tracked = (await run('git', ['ls-files', '*.ts'], repoRoot)).output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, FILES);
    expect(tracked).toHaveLength(FILES);

    const before = (await run('git', ['diff', '--name-only', ...tracked], repoRoot)).output;
    const args = ['run', 'pre-commit', '--force', '--no-stage-fixed', '--no-tty'];
    for (const file of tracked) args.push('--file', file);

    const timings: number[] = [];
    for (let attempt = 0; attempt < RUNS; attempt += 1) {
      const started = process.hrtime.bigint();
      const result = await run(LEFTHOOK, args, repoRoot);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(result.code, result.output).toBe(0);
    }

    // The measurement must not have been bought by mutating the repository.
    expect((await run('git', ['diff', '--name-only', ...tracked], repoRoot)).output).toBe(before);

    const median = [...timings].sort((a, b) => a - b)[Math.floor(RUNS / 2)] ?? Number.NaN;
    // Printed, not merely asserted: docs/CONTRIBUTING.md records a number, and a
    // number nobody can reproduce from a test log is folklore.
    console.log(
      `pre-commit over ${FILES} files: median ${median.toFixed(0)} ms ` +
        `(${timings.map((value) => value.toFixed(0)).join('/')} ms)`,
    );

    expect(
      median,
      `The pre-commit hook's median is ${median.toFixed(0)} ms over ${FILES} files, past the ` +
        `${BUDGET_MS} ms budget. Do not raise the budget — the moment you type "--no-verify" the ` +
        'hooks stop existing and you have paid the setup cost for nothing. Typecheck, type-aware ' +
        'lint and the full suite belong on pre-push and in CI.',
    ).toBeLessThan(BUDGET_MS);
  });
});
