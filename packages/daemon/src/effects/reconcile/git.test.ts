/**
 * KAR-06.4 — git made structurally idempotent instead of journalled around
 * (docs/05-durable-execution.md §8.3).
 *
 * The two decisions this file holds are string decisions, so they are unit
 * tests: which argv carries the ikey into the commit, and which failure of
 * `git worktree add` is a success. Both are exercised against a real `git`
 * child process in `test/integration/reconcile-git.test.ts` — the point of
 * testing them here as well is that the *distinction* between the two
 * worktree errors can be stated exhaustively here, including the shapes real
 * git prints that a spec would otherwise never think to produce.
 *
 * Verifies: EPIC-06-S13 · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import {
  classifyWorktreeAdd,
  commitArgs,
  EFFECT_TRAILER,
  findCommitArgs,
  trailerLine,
} from './git.ts';

const IKEY = 'run_20260805T090000Z_5c1d2e/implement/0/2';

suite('the DeFlow-Effect-Id trailer (EPIC-06-S13, AC7)', () => {
  it('is a second -m, so git parses it as a trailer rather than subject text', () => {
    expect(commitArgs('implement: add the reconcile probe', IKEY)).toEqual([
      'commit',
      '-m',
      'implement: add the reconcile probe',
      '-m',
      `${EFFECT_TRAILER}: ${IKEY}`,
    ]);
  });

  it('greps for the exact trailer line, fixed-string, newest first, one result', () => {
    expect(findCommitArgs(IKEY)).toEqual([
      'log',
      '--fixed-strings',
      `--grep=${trailerLine(IKEY)}`,
      '--format=%H',
      '-1',
    ]);
  });

  it('greps as a fixed string because an ikey is not a regular expression', () => {
    // `/` is harmless, but the key is built from ids this module does not own
    // and a `.` or a `+` reaching --grep as a metacharacter would match the
    // wrong commit — the one failure mode where reconcile answers "done" about
    // somebody else's work.
    const args = findCommitArgs(IKEY);
    expect(args).toContain('--fixed-strings');
    expect(args.indexOf('--fixed-strings')).toBeLessThan(
      args.findIndex((arg) => arg.startsWith('--grep=')),
    );
  });
});

suite('`git worktree add` is idempotent by construction (EPIC-06-S13, AC7)', () => {
  it('is created on a clean exit', () => {
    expect(classifyWorktreeAdd({ exitCode: 0, stdout: '', stderr: '' })).toBe('created');
  });

  it('maps a non-zero exit whose message contains "already exists" to a SUCCESS', () => {
    expect(
      classifyWorktreeAdd({
        exitCode: 128,
        stdout: '',
        stderr: "fatal: '/repo/.DeFlow/wt/run__implement' already exists",
      }),
    ).toBe('already-exists');
  });

  it('reads the message off stdout too, because git does not always use stderr', () => {
    expect(
      classifyWorktreeAdd({
        exitCode: 128,
        stdout: "fatal: '/repo/.DeFlow/wt/run__implement' already exists",
        stderr: '',
      }),
    ).toBe('already-exists');
  });

  it('does NOT map "already used by worktree at" to success — that is a real collision', () => {
    // The real string for a branch already checked out elsewhere, verified
    // 2026-08-02. Most blog posts claim "is already checked out at", which is
    // why matching loosely on "already" turns a genuine collision into a
    // silent success.
    expect(
      classifyWorktreeAdd({
        exitCode: 128,
        stdout: '',
        stderr:
          "fatal: 'DeFlow/run_20260805T090000Z_5c1d2e__implement' is already used by worktree at '/repo/.DeFlow/wt/other'",
      }),
    ).toBe('failed');
  });

  it('is failed for any other non-zero exit', () => {
    expect(
      classifyWorktreeAdd({
        exitCode: 128,
        stdout: '',
        stderr: "fatal: invalid reference: 'nope'",
      }),
    ).toBe('failed');
  });
});
