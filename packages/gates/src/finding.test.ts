/**
 * KAR-12.1 — the stable finding id and the two path normalisations every
 * parser output goes through.
 *
 * The id's full stability contract is KAR-12.3's; what this story needs, and
 * what S7 asserts, is that every parser produces one and that it is exactly
 * twelve hex characters of `sha256(gate|file|rule|normalisedMessage)`.
 *
 * Verifies: EPIC-12-S7 · AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { findingId, normaliseMessage, repoRelativePosix } from './finding.ts';

suite('findingId', () => {
  it('is twelve lowercase hex characters', () => {
    expect(findingId('typecheck', 'packages/ui/src/App.ts', 'ts2345', 'nope')).toMatch(
      /^[0-9a-f]{12}$/,
    );
  });

  it('is stable across calls', () => {
    const once = findingId('typecheck', 'a.ts', 'ts2345', 'nope');
    expect(findingId('typecheck', 'a.ts', 'ts2345', 'nope')).toBe(once);
  });

  it('changes when the rule changes', () => {
    expect(findingId('typecheck', 'a.ts', 'ts2345', 'nope')).not.toBe(
      findingId('typecheck', 'a.ts', 'ts2322', 'nope'),
    );
  });

  it('changes when the gate changes, so two gates never collide on one id', () => {
    expect(findingId('typecheck', 'a.ts', 'ts2345', 'nope')).not.toBe(
      findingId('lint', 'a.ts', 'ts2345', 'nope'),
    );
  });

  it('survives a line number moving inside the message', () => {
    expect(findingId('unit', 'a.ts', 'test/failed', 'failed at a.ts:8:17')).toBe(
      findingId('unit', 'a.ts', 'test/failed', 'failed at a.ts:19:17'),
    );
  });
});

suite('normaliseMessage', () => {
  it('collapses runs of whitespace, so a re-wrapped message is the same message', () => {
    expect(normaliseMessage('expected   3\n  to be 4')).toBe(
      normaliseMessage('expected 3 to be 4'),
    );
  });

  it('replaces the variable numeric part', () => {
    expect(normaliseMessage('bundle is 214 KB')).toBe(normaliseMessage('bundle is 218 KB'));
  });

  it('keeps the words, so two different messages stay different', () => {
    expect(normaliseMessage('bundle is 214 KB')).not.toBe(normaliseMessage('bundle is 214 MB'));
  });
});

suite('repoRelativePosix', () => {
  it('makes an absolute path repo-relative', () => {
    expect(repoRelativePosix('/tmp/repo', '/tmp/repo/packages/ui/src/App.vue')).toBe(
      'packages/ui/src/App.vue',
    );
  });

  it('normalises win32 separators (S7, third scenario)', () => {
    expect(repoRelativePosix('/tmp/repo', 'packages\\ui\\src\\App.vue')).toBe(
      'packages/ui/src/App.vue',
    );
  });

  it('leaves an already repo-relative POSIX path alone', () => {
    expect(repoRelativePosix('/tmp/repo', 'packages/ui/src/App.vue')).toBe(
      'packages/ui/src/App.vue',
    );
  });

  it('keeps a path outside the repo recognisable rather than inventing one', () => {
    expect(repoRelativePosix('/tmp/repo', '/etc/hosts')).toBe('/etc/hosts');
  });
});
