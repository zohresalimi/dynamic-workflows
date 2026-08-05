/**
 * KAR-06.4 — the `shell` probe: the one effect kind whose honest answer is
 * often "cannot tell" (docs/05-durable-execution.md §8.3).
 *
 * A unit test because the verdict is a pure function of three strings — the
 * journalled before-hash, the journalled after-hash and the hash observed
 * right now. Producing those hashes from a real dirty worktree is
 * `test/integration/reconcile-shell.test.ts`; deciding what they *mean* is
 * here, where the whole table can be stated at once.
 *
 * Verifies: EPIC-06-S12 (shell rows), EPIC-06-S15 · AC4, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { type MutatingShellScaffold, porcelainHash, reconcileShell } from './shell.ts';

const BEFORE = `sha256-${'1'.repeat(64)}`;
const AFTER = `sha256-${'2'.repeat(64)}`;
const THIRD = `sha256-${'3'.repeat(64)}`;

const scaffold = (
  after: string | null,
  result: unknown = { exitCode: 0 },
): MutatingShellScaffold => ({
  kind: 'shell.mutating',
  before: BEFORE,
  after,
  result,
});

suite('shell `pure`: re-running it is the whole recovery story (AC4)', () => {
  it('answers not-started whatever the worktree looks like now', () => {
    for (const observed of [BEFORE, AFTER, THIRD]) {
      expect(reconcileShell({ classification: 'pure', scaffold: null, observed })).toEqual({
        status: 'not-started',
      });
    }
  });

  it('answers not-started even when a scaffold happens to be there', () => {
    // A node reclassified from `mutating` to `pure` by a plan edit leaves the
    // old scaffold behind. `pure` is a claim that re-running is free of
    // consequence, so the hashes are not consulted rather than half-trusted.
    expect(
      reconcileShell({ classification: 'pure', scaffold: scaffold(AFTER), observed: AFTER }),
    ).toEqual({ status: 'not-started' });
  });
});

suite('shell `mutating`: three hashes, three answers (AC5, EPIC-06-S12)', () => {
  it('matches the BEFORE hash ⇒ not-started, so the command re-runs', () => {
    expect(
      reconcileShell({ classification: 'mutating', scaffold: scaffold(null), observed: BEFORE }),
    ).toEqual({ status: 'not-started' });
  });

  it('matches the AFTER hash ⇒ done, memoising the journalled result', () => {
    expect(
      reconcileShell({
        classification: 'mutating',
        scaffold: scaffold(AFTER, { exitCode: 0, stdout: 'migrated' }),
        observed: AFTER,
      }),
    ).toEqual({ status: 'done', result: { exitCode: 0, stdout: 'migrated' } });
  });

  it('matches neither ⇒ unknown, carrying all three hashes as evidence (AC10)', () => {
    expect(
      reconcileShell({ classification: 'mutating', scaffold: scaffold(AFTER), observed: THIRD }),
    ).toEqual({ status: 'unknown', before: BEFORE, after: AFTER, observed: THIRD });
  });

  it('is unknown — not done — when the after-hash was never journalled and the world moved', () => {
    // The crash landed between the command finishing and the after-hash being
    // written. There is nothing to match against, and "it probably worked" is
    // exactly the guess this story exists to refuse.
    expect(
      reconcileShell({ classification: 'mutating', scaffold: scaffold(null), observed: THIRD }),
    ).toEqual({ status: 'unknown', before: BEFORE, after: null, observed: THIRD });
  });

  it('is not-started when no scaffold exists at all: the write-ahead order says so', () => {
    // The scaffold is committed *before* the command is spawned, exactly as
    // the intent row is committed before the effect. No scaffold therefore
    // means no spawn — the same argument the whole journal rests on, not an
    // optimistic reading of a missing row.
    expect(reconcileShell({ classification: 'mutating', scaffold: null, observed: THIRD })).toEqual(
      { status: 'not-started' },
    );
  });
});

suite('porcelainHash', () => {
  it('is the sha256 of the exact bytes `git status --porcelain` printed', async () => {
    const clean = await porcelainHash('');
    const dirty = await porcelainHash(' M packages/core/src/decide.ts\n');
    expect(clean).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(dirty).not.toBe(clean);
    expect(await porcelainHash(' M packages/core/src/decide.ts\n')).toBe(dirty);
  });

  it('does not collapse whitespace: a rename and an edit are different worlds', async () => {
    expect(await porcelainHash('?? a\n?? b\n')).not.toBe(await porcelainHash('?? a\n?? b'));
  });
});
