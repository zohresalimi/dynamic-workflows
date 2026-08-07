/**
 * KAR-09.5 AC4, AC5 — who may resolve a handle, and to exactly which bytes.
 *
 * Unit, because every answer here is a function of `(handle, level, scope)`
 * with no disk in it — the same property that makes `decidePermission` a table
 * rather than a matrix of vendor flags. The half that reads a real file and a
 * real store is the daemon's `read-artifact-handle` integration spec.
 *
 * Verifies: EPIC-09-S27 (third scenario), EPIC-09-S29 (first scenario) · AC4
 */
import { expect, it, describe as suite } from 'vitest';
import {
  decideFileHandleAccess,
  type NodeHandleAccess,
  parseHandle,
  sliceLines,
} from './handle-access.ts';
import type { PermissionScope } from './permission.ts';
import type { PermissionLevel } from './plan-graph.ts';

const WORKTREE = '/tmp/DeFlow-worktrees/review';

const scope: PermissionScope = {
  worktree: WORKTREE,
  allowlist: ['git', 'pnpm'],
  readOnlyCommands: ['git status'],
  allowedDomains: [],
  scrubbedEnv: [],
};

function access(level: PermissionLevel, readScope: readonly string[] = []): NodeHandleAccess {
  return { level, scope, readScope };
}

const DIGEST = 'a'.repeat(64);

suite('the handle grammar, as §1 writes it', () => {
  it('reads an artifact:// handle as a digest', () => {
    expect(parseHandle(`artifact://${DIGEST}`)).toEqual({ scheme: 'artifact', sha256: DIGEST });
  });

  it('reads a file:// handle as a repo-relative path and a line range', () => {
    expect(parseHandle('file://packages/core/src/reduce.ts#L12-L40')).toEqual({
      scheme: 'file',
      path: 'packages/core/src/reduce.ts',
      firstLine: 12,
      lastLine: 40,
    });
  });

  it('refuses everything that is not one of the two', () => {
    expect(parseHandle('')).toBeNull();
    expect(parseHandle('artifact://not-a-digest')).toBeNull();
    expect(parseHandle(`artifact://${DIGEST.toUpperCase()}`)).toBeNull();
    expect(parseHandle(`artifact://${'a'.repeat(63)}`)).toBeNull();
    // An absolute path is not a repo-relative one, and the difference is the
    // whole containment argument.
    expect(parseHandle('file:///etc/passwd#L1-L2')).toBeNull();
    expect(parseHandle('file://src/a.ts')).toBeNull();
    expect(parseHandle('https://example.com/log.txt')).toBeNull();
  });

  it('refuses a range that runs backwards', () => {
    expect(parseHandle('file://src/a.ts#L40-L12')).toBeNull();
    expect(parseHandle('file://src/a.ts#L0-L4')).toBeNull();
  });
});

suite('a line range means exactly that line range (EPIC-09-S27, AC4)', () => {
  const text = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n');

  it('returns lines 12 to 40 inclusive, 1-based', () => {
    const slice = sliceLines(text, 12, 40);
    expect(slice?.split('\n').length).toBe(29);
    expect(slice?.startsWith('line 12')).toBe(true);
    expect(slice?.endsWith('line 40')).toBe(true);
  });

  it('stops at the end of the file rather than inventing blank lines', () => {
    expect(sliceLines(text, 58, 400)?.split('\n')).toEqual(['line 58', 'line 59', 'line 60']);
  });

  it('returns null when the range starts past the end — never an empty body', () => {
    expect(sliceLines(text, 61, 80)).toBeNull();
  });
});

suite('DeFlow_read_artifact is not a permission bypass (EPIC-09-S29, AC4)', () => {
  const secrets = parseHandle('file://infra/secrets.tf#L1-L20');
  const inScope = parseHandle('file://src/checkout/cart.ts#L1-L20');

  it('refuses a read-level node reaching outside its declared read scope', () => {
    const refusal = decideFileHandleAccess(secrets, access('read', ['src/checkout/**']));

    expect(refusal?.code).toBe('scope-violation');
    // "naming the level and the scope" — both, so the agent and the operator
    // can see which rule fired and what it was measured against.
    expect(refusal?.message).toContain('read');
    expect(refusal?.message).toContain('src/checkout/**');
    expect(refusal?.message).toContain('infra/secrets.tf');
  });

  it('allows the same node the paths it did declare', () => {
    expect(decideFileHandleAccess(inScope, access('read', ['src/checkout/**']))).toBeNull();
  });

  it('refuses a path that escapes the worktree, whatever the level', () => {
    const escape = parseHandle('file://../../etc/passwd#L1-L2');
    for (const level of ['read', 'worktree', 'worktree+net', 'full'] as const) {
      expect(decideFileHandleAccess(escape, access(level))?.code).toBe('permission-denied');
    }
  });

  it('fails closed when the node’s scope was never wired up', () => {
    const refusal = decideFileHandleAccess(secrets, undefined);
    expect(refusal?.code).toBe('permission-denied');
    expect(refusal?.message).toMatch(/scope/i);
  });

  it('refuses a malformed handle rather than guessing at it', () => {
    expect(decideFileHandleAccess(null, access('read'))?.code).toBe('handle-malformed');
  });

  it('lets a node with no declared read scope read inside its own worktree', () => {
    expect(decideFileHandleAccess(secrets, access('worktree'))).toBeNull();
  });

  it('carries what permission.denied needs, without formatting it into prose', () => {
    const refusal = decideFileHandleAccess(secrets, access('read', ['src/checkout/**']));

    expect(refusal?.denial).toEqual({
      method: 'fs/read_text_file',
      requested: 'file://infra/secrets.tf#L1-L20',
      permission: 'read',
      reason: { code: 'scope-violation', detail: 'infra/secrets.tf' },
      declared: ['src/checkout/**'],
    });
  });
});
