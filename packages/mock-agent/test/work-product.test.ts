/**
 * KAR-23.11 — what the built-in turn writes, and when it writes nothing.
 *
 * The derivation is tested against the *pinned* segment `compilePinnedSegments`
 * really produces rather than against a phrase invented here, because that
 * string is the contract: DeFlow composes it in one function and the agent reads
 * it back off the wire, and a spec written against a paraphrase would stay green
 * through the rename that breaks the smoke test.
 *
 * Verifies: KAR-23.11
 */
import {
  declaredWriteGlobs,
  WORK_PRODUCT_BASENAME,
  workProductFor,
  workProductPath,
} from '@DeFlow/mock-agent';
import { expect, it, describe as suite } from 'vitest';

/** The pinned path-scope segment, exactly as `compilePinnedSegments` writes it. */
const pinned = (globs: readonly string[]): string =>
  [
    'Safety constraints (pinned):',
    '- Change nothing outside the declared scope.',
    '',
    'Declared path scopes (pinned):',
    ...(globs.length === 0
      ? ['- this node declares no write scope and must not write']
      : globs.map((glob) => `- write: ${glob}`)),
    '',
    'Permission level (pinned): worktree',
  ].join('\n');

suite('KAR-23.11 — the declared write scope, read off the brief', () => {
  it('finds every glob the pinned segment declares, in order', () => {
    expect(declaredWriteGlobs(pinned(['src/**', 'docs/*.md']))).toEqual(['src/**', 'docs/*.md']);
  });

  it('finds none for a node the plan told not to write', () => {
    // The sentence `compilePinnedSegments` writes for `pathScopes.write: []`.
    // This is the whole reason a reviewer or a verification node stays out of
    // the work-product check: no glob line, no write, nothing to audit.
    expect(declaredWriteGlobs(pinned([]))).toEqual([]);
    expect(workProductFor(pinned([]))).toBeNull();
  });

  it('finds none in a prompt that carries no pinned scope segment at all', () => {
    // Every turn this binary serves outside a DeFlow node — which is most of
    // its own suite — and the reason nothing else changed behaviour.
    expect(declaredWriteGlobs('Do the task.')).toEqual([]);
    expect(workProductFor('Do the task.')).toBeNull();
  });

  it('ignores a negated pattern, which re-includes nothing', () => {
    // `.gitignore` semantics: the last matching pattern decides, so a path
    // derived from `!dist/**` would be a path the scope excludes.
    expect(declaredWriteGlobs(pinned(['!dist/**']))).toEqual([]);
  });
});

suite('KAR-23.11 — the path the note lands on', () => {
  it.each([
    ['**', `${WORK_PRODUCT_BASENAME}.md`],
    ['src/**', `src/${WORK_PRODUCT_BASENAME}.md`],
    ['packages/core/src/**/*.ts', `packages/core/src/${WORK_PRODUCT_BASENAME}.ts`],
    ['docs/*.md', `docs/${WORK_PRODUCT_BASENAME}.md`],
    ['dist/', `dist/${WORK_PRODUCT_BASENAME}.md`],
    ['README.md', 'README.md'],
  ])('derives %s → %s', (glob, path) => {
    expect(workProductPath(glob)).toBe(path);
  });

  it('writes the file the brief declared, with bytes in it', () => {
    const product = workProductFor(pinned(['src/**']));

    expect(product?.path).toBe(`src/${WORK_PRODUCT_BASENAME}.md`);
    // A zero-byte file is a change and would satisfy the work-product rule, so
    // this is about the double being useful rather than about passing: a spec
    // that wants to read what the node produced needs something to read.
    expect((product?.content.length ?? 0) > 0).toBe(true);
    expect(product?.content).toContain('src/**');
  });

  it('is a function of the declared scope and of nothing else', () => {
    // ./structured.ts's determinism rule, applied to the other output this
    // binary produces: no clock, no randomness, no cwd.
    expect(workProductFor(pinned(['src/**']))).toEqual(workProductFor(pinned(['src/**'])));
  });
});
