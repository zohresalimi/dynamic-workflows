/**
 * KAR-19.8 AC5, AC6 — the two facts that have to agree before DeFlow blames its
 * own argv, and what the failure says once they do.
 *
 * The integration specs drive this through real children
 * (`test/integration/vendor-session-id.test.ts`,
 * `packages/daemon/test/integration/vendor-session-id.test.ts`). What is
 * settled here is the *rule*: a classifier that blamed the argv for every
 * non-zero exit would turn every ordinary vendor error into a permanent failure
 * nobody retries, which is the same defect as 2026-08-13's with the sign
 * flipped.
 *
 * Verifies: EPIC-19-S55 · KAR-19.8 AC5, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { argumentRefused, rejectedArgument } from '../src/argument-refusal.ts';
import { PROVIDER_SPECS } from '../src/provider-registry.ts';

const SESSION = 'run_20260813T110608Z_379fc8-framing';
const ARGV = ['-p', 'do the thing', '--output-format', 'stream-json', '--session-id', SESSION];

suite('KAR-19.8 AC5 — the flag DeFlow passed, named from what the child said', () => {
  it('blames the flag the child named, and reports the value that followed it', () => {
    const rejected = rejectedArgument({
      argv: ARGV,
      stderr: "error: unknown option '--session-id'",
    });

    expect(rejected).toEqual({ flag: '--session-id', value: SESSION });
  });

  it('blames the session-id flag when the vendor names the subject and not the flag', () => {
    // Claude Code 2.1.220's actual words, which never mention `--session-id`.
    const rejected = rejectedArgument({
      argv: ARGV,
      stderr: 'Error: Invalid session ID. Must be a valid UUID.',
      spec: PROVIDER_SPECS.claude,
    });

    expect(rejected).toEqual({ flag: '--session-id', value: SESSION });
  });

  it('reads the flag off the entry rather than out of a literal', () => {
    // The same stderr against an entry that passes no session id at all: there
    // is no flag to blame, so nothing is blamed.
    const rejected = rejectedArgument({
      argv: ['exec', '--json', 'do the thing'],
      stderr: 'Error: Invalid session ID. Must be a valid UUID.',
      spec: PROVIDER_SPECS.codex,
    });

    expect(rejected).toBeNull();
  });

  it('reports no value for a flag that takes none', () => {
    const rejected = rejectedArgument({
      argv: ['-p', 'do the thing', '--verbose'],
      stderr: "error: unknown option '--verbose'",
    });

    expect(rejected).toEqual({ flag: '--verbose', value: null });
  });
});

suite('KAR-19.8 AC6 — it stays silent unless both facts agree', () => {
  it.each([
    ['an ordinary turn failure', 'The model endpoint reset the connection'],
    ['an empty stderr', ''],
    ['a message about the work rather than the argv', 'Failed to read src/index.ts'],
  ])('says nothing about %s', (_case, stderr) => {
    expect(rejectedArgument({ argv: ARGV, stderr, spec: PROVIDER_SPECS.claude })).toBeNull();
  });

  it('says nothing when the refused thing is not on the argv DeFlow built', () => {
    const rejected = rejectedArgument({
      argv: ['-p', 'do the thing'],
      stderr: "error: unknown option '--fork-session'",
    });

    expect(rejected).toBeNull();
  });
});

suite('KAR-19.8 AC6 — the failure it produces', () => {
  const failure = (value: string): ReturnType<typeof argumentRefused> =>
    argumentRefused({
      provider: 'claude',
      rejected: { flag: '--session-id', value },
      stderr: 'Error: Invalid session ID. Must be a valid UUID.\n',
      code: 1,
      signal: null,
    });

  it('is permanent, and carries the flag, the value and the child’s own words', () => {
    const thrown = failure(SESSION);

    expect(thrown.deflowFailure.class).toBe('permanent');
    expect(thrown.deflowFailure.reason).toBe('agent.nonzero-exit');
    expect(thrown.deflowFailure.detail).toMatchObject({
      provider: 'claude',
      flag: '--session-id',
      value: SESSION,
      code: 1,
      stderr: 'Error: Invalid session ID. Must be a valid UUID.',
    });
    expect(thrown.message).toContain('--session-id');
    expect(thrown.message).toContain(SESSION);
  });

  it('bounds the value it records, because one argument’s value is a prompt', () => {
    // `-p` is an argument DeFlow chooses too, and the ledger keeps a
    // `node.failed` payload for ever — once per attempt.
    const thrown = failure(`Safety constraints (pinned):\n${'word '.repeat(400)}`);

    const value = String(thrown.deflowFailure.detail?.value);
    expect(value.length).toBeLessThan(320);
    expect(value).not.toContain('\n');
    expect(value.endsWith('…')).toBe(true);
  });
});
