/**
 * KAR-08.4 AC7 — the grep half of "one environment builder"
 * (docs/15-security-model.md §1.2 check 2).
 *
 * `buildChildEnv()` (../src/proc/env.ts) is the only function that may build
 * an *agent*-reachable child environment by spreading DeFlowd's own
 * `process.env`. Two other builders exist, named here rather than merely
 * excluded, because a list of exceptions with no reason attached is a list
 * the next refactor is free to grow:
 *
 *  - `gitChildEnv()` (../src/git/run-git.ts) — the agent never pushes; the
 *    `Git` wrapper does, and it needs the user's real environment to do it
 *    (docs/09-workspace-and-safety.md §1.1).
 *  - `setupChildEnv()` (../src/workspace/run-setup.ts) — `workspace.setup` is
 *    a command line the repository owner authored, run once at worktree
 *    provisioning, before any agent exists to prompt-inject.
 *
 * A file outside that allowlist that spreads `process.env` (or assigns it
 * directly) is either a second, undocumented environment builder or a
 * regression of the fix this story made to
 * `packages/daemon/src/services/terminal-service.ts` — both fail this test.
 *
 * The complementary half — a lint rule scoped to the specific known
 * agent-adjacent spawn sites — lives in `.oxlintrc.json`'s override for
 * `packages/daemon/src/services/terminal-service.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const ROOTS = [
  fileURLToPath(new URL('../src/', import.meta.url)),
  fileURLToPath(new URL('../../adapters/src/', import.meta.url)),
];

/** The two deliberate exceptions, as paths relative to their own package's
 * `src/`. Anything else that matches the pattern below is an offender. */
const ALLOWED = new Set(['git/run-git.ts', 'workspace/run-setup.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** A file "builds a child env from process.env" when it spreads it into an
 * object, or assigns it directly to an `env` field or variable — the two
 * shapes `terminal-service.ts` had before this story's fix. */
const INLINE_PROCESS_ENV = /\.\.\.\s*process\.env\b|\benv\s*[:=]\s*process\.env\b/;

/** `.../packages/daemon/src/git/run-git.ts` -> `src/git/run-git.ts`, so a
 * failure message names a file relative to its own package. */
function displayPath(path: string): string {
  const at = path.lastIndexOf('/src/');
  return at === -1 ? path : path.slice(at + 1);
}

export function offendingSources(): string[] {
  return ROOTS.flatMap((root) =>
    sourceFiles(root)
      .filter((path) => INLINE_PROCESS_ENV.test(codeOnly(readFileSync(path, 'utf8'))))
      .filter((path) => ![...ALLOWED].some((allowed) => path.endsWith(allowed)))
      .map(displayPath),
  );
}

suite('buildChildEnv() is the only function that builds an agent child env (AC7)', () => {
  it('found sources to check at all', () => {
    const total = ROOTS.flatMap(sourceFiles).length;
    expect(total).toBeGreaterThan(10);
  });

  it('no file outside the two documented exceptions spreads process.env into a child env', () => {
    expect(
      offendingSources(),
      'Build the environment with buildChildEnv() (packages/daemon/src/proc/env.ts) and pass ' +
        'the result in. If this really is a third deliberate exception, name it in ' +
        "this test's ALLOWED set with the same reasoning gitChildEnv/setupChildEnv carry.",
    ).toEqual([]);
  });

  it('the check is not vacuous', () => {
    expect(INLINE_PROCESS_ENV.test('const env = { ...process.env, FOO: "1" };')).toBe(true);
    expect(INLINE_PROCESS_ENV.test('env: process.env,')).toBe(true);
    expect(INLINE_PROCESS_ENV.test('env = process.env;')).toBe(true);
    expect(INLINE_PROCESS_ENV.test('const env = buildChildEnv(options).env;')).toBe(false);
    // A comment mentioning the pattern must not itself trip the check — that
    // is what codeOnly() is for, and this line proves the fixture is honest
    // about testing the regex the same way the real check does.
    expect(INLINE_PROCESS_ENV.test(codeOnly('// ...process.env used to leak here'))).toBe(false);
  });

  it('the two exceptions are themselves real files, or the allowlist proves nothing', () => {
    const found = ROOTS.flatMap(sourceFiles);
    for (const allowed of ALLOWED) {
      expect(
        found.some((path) => path.endsWith(allowed)),
        allowed,
      ).toBe(true);
    }
  });
});
