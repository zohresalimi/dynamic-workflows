/**
 * KAR-17.6 — builds `test/fixtures/diffs/review.patch` by **running git**.
 *
 * The diff surface parses a unified patch, and the only patches worth testing a
 * parser against are the ones git actually writes. A hand-authored patch is a
 * parser's own idea of a patch: it has the hunk headers the author remembered
 * and none of the parts they did not — `similarity index`, `rename from`/
 * `rename to`, `new file mode`, `deleted file mode`, `\ No newline at end of
 * file`, and the base85 `GIT binary patch` block that `--binary` emits and that
 * looks nothing like a text hunk.
 *
 * The command is **the daemon's own** (`packages/daemon/src/http/api.ts`
 * `worktreePatch`): a temporary `GIT_INDEX_FILE`, `read-tree` from the base
 * commit, `add -A` so files an agent created and never added are included, then
 * `diff --cached --no-color --no-ext-diff --binary`. Copying the flags is the
 * point — a fixture produced by a *different* git invocation would be a fixture
 * of a patch the UI never receives.
 *
 * The repository is built under an `fs.mkdtemp` directory with
 * `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` and a fixed
 * synthetic identity, so nothing about the machine that ran it — a home
 * directory, a name, an email — can reach the committed bytes.
 *
 * The content mirrors `test/fixtures/runs/gate-failure-repair/`: the same
 * `src/date-picker.ts` bug at line 2 that the recorded `blocker` finding names,
 * so the browser spec can attach a real finding to a real line of a real patch.
 *
 * Usage:
 *   node packages/web/scripts/build-diff-fixture.ts [outFile]
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Where the committed copy lives, relative to this file. */
export const REVIEW_PATCH_FILE = fileURLToPath(
  new URL('../../../test/fixtures/diffs/review.patch', import.meta.url),
);

/**
 * The hermetic git environment. Identical in spirit to the gate-repair
 * fixture's: a committed patch that moved with the wall clock or with whoever
 * built it would be a different fixture on every machine.
 */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'DeFlow fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'DeFlow fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2026-08-10T09:00:00Z',
  GIT_COMMITTER_DATE: '2026-08-10T09:00:00Z',
};

/** The producer's bug, verbatim from the gate-repair fixture: line 2 is wrong. */
const BUGGY = 'export function daysUntil(target: Date): number {\n  return target;\n}\n';

const FIXED =
  'export function daysUntil(target: Date): number {\n' +
  '  return Math.round(target.getTime() / 86_400_000);\n}\n';

/** The regression test the fix node writes before the fix — an added file. */
const REGRESSION =
  "import { daysUntil } from '../src/date-picker.ts';\n\n" +
  'export const days: number = daysUntil(new Date());\n';

/** Renamed rather than rewritten, so git emits `rename from` / `rename to`. */
const MOVED = `export const FORMAT = 'iso-8601';\n${'export const PAD = 2;\n'.repeat(12)}`;

/** Deleted outright, so git emits `deleted file mode`. */
const DEAD = 'export const unused = true;\n';

/**
 * The file `happy-path-12`'s contract gate reported findings on, at lines 12
 * and 31 — long enough that both line numbers exist and are changed, so the
 * browser spec can attach that recording's `major` and `minor` findings to real
 * lines of a real patch.
 */
const contract = (verified: string, field: string): string =>
  [
    /* 1 */ "import type { Email } from './types.ts';",
    /* 2 */ '',
    /* 3 */ 'export interface SignupRequest {',
    /* 4 */ '  readonly email: Email;',
    /* 5 */ '  readonly password: string;',
    /* 6-10 */ ...Array.from({ length: 5 }, (_, i) => `  readonly extra${i}?: string;`),
    /* 11 */ '}',
    /* 12 */ `// request field: ${field}`,
    /* 13 */ '',
    /* 14 */ 'export interface SignupResponse {',
    /* 15 */ '  readonly id: string;',
    /* 16-29 */ ...Array.from({ length: 14 }, (_, i) => `  readonly pad${i}: string;`),
    /* 30 */ '',
    /* 31 */ `  readonly ${verified}: boolean;`,
    /* 32 */ '}',
    /* 33 */ '',
    /* 34 */ 'export const SIGNUP_PATH = "/api/signup";',
    '',
  ].join('\n');

const CONTRACT_BEFORE = contract('emailVerified', 'none');
const CONTRACT_AFTER = contract('verifiedAt', 'optional');

/** A one-pixel PNG. Synthetic bytes, and the smallest thing git calls binary. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}) {
  return await exec('git', [...args], { cwd, env: { ...GIT_ENV, ...env }, maxBuffer: 32 << 20 });
}

/**
 * Builds the repository the patch is taken of, in `repo`, and leaves it
 * **dirty** — one commit of the "before" state, and the run's change sitting
 * uncommitted in the working tree exactly as an agent would have left it.
 *
 * Exported because a patch and a repository are two different things to need.
 * `buildReviewPatch` below wants the bytes; `../../../e2e/diff-review.test.ts`
 * wants a directory a real `DeFlowd` can run `git diff` in, because the journey
 * it follows only means anything if the patch on screen came off a real
 * repository through the real endpoint.
 *
 * Answers the base commit, which is the revision the daemon diffs from.
 */
export async function materialiseReviewRepo(repo: string): Promise<string> {
  await mkdir(join(repo, 'src', 'api'), { recursive: true });
  await mkdir(join(repo, 'test'), { recursive: true });
  await mkdir(join(repo, 'assets'), { recursive: true });

  await writeFile(join(repo, 'src', 'date-picker.ts'), BUGGY);
  await writeFile(join(repo, 'src', 'api', 'contract.ts'), CONTRACT_BEFORE);
  await writeFile(join(repo, 'src', 'legacy-format.ts'), MOVED);
  await writeFile(join(repo, 'src', 'dead-code.ts'), DEAD);
  await writeFile(join(repo, 'assets', 'logo.png'), PNG);

  await git(repo, ['init', '--quiet', '--initial-branch=main']);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--quiet', '-m', 'base']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

  // The change the run produced: a fix, a new test, a rename, a delete, and
  // a binary file whose bytes changed.
  await writeFile(join(repo, 'src', 'date-picker.ts'), FIXED);
  await writeFile(join(repo, 'src', 'api', 'contract.ts'), CONTRACT_AFTER);
  await writeFile(join(repo, 'test', 'days-until.test.ts'), REGRESSION);
  await writeFile(join(repo, 'src', 'formatting.ts'), MOVED);
  await rm(join(repo, 'src', 'legacy-format.ts'));
  await rm(join(repo, 'src', 'dead-code.ts'));
  await writeFile(join(repo, 'assets', 'logo.png'), Buffer.concat([PNG, Buffer.from([0, 1, 2])]));

  return base;
}

/**
 * A patch of one repository's change, produced exactly the way `DeFlowd` does.
 *
 * Exported so `../test/integration/patch-real-git.test.ts` can assert the
 * parser against a patch git wrote **during the test run**, rather than only
 * against the committed copy — a fixture can go stale against a newer git, and
 * the point of the row in the test plan is that it does not go unnoticed.
 */
export async function buildReviewPatch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'DeFlow-diff-fixture-'));
  const repo = join(root, 'repo');

  try {
    const base = await materialiseReviewRepo(repo);

    // `worktreePatch`'s exact shape: a scratch index, so the repository's own
    // index and worktree are untouched and untracked files are still included.
    const index = join(root, 'scratch-index');
    await git(repo, ['read-tree', base], { GIT_INDEX_FILE: index });
    await git(repo, ['add', '-A'], { GIT_INDEX_FILE: index });
    const diff = await git(
      repo,
      ['diff', '--cached', '--no-color', '--no-ext-diff', '--binary', base],
      { GIT_INDEX_FILE: index },
    );

    return diff.stdout;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))
) {
  const out = process.argv[2] ?? REVIEW_PATCH_FILE;
  const patch = await buildReviewPatch();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, patch, 'utf8');
  process.stdout.write(`wrote ${patch.length} bytes to ${out}\n`);
}
