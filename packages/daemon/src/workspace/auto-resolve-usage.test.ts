/**
 * KAR-07.7 — the pure matcher behind the repo-wide "no blind auto-resolution"
 * grep (../../test/no-auto-resolve.test.ts).
 *
 * Written before ./auto-resolve-usage.ts exists. Exercised directly here, over
 * synthetic snippets, so the policy check is proven non-vacuous rather than
 * trusted to have caught something by accident — including the case it must
 * *not* catch, which is the prose explaining why the option is forbidden.
 *
 * Verifies: EPIC-07-S27's second scenario · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { findAutoResolveStrategies, stripComments } from './auto-resolve-usage.ts';

suite('findAutoResolveStrategies', () => {
  it('flags the separated -X form', () => {
    expect(findAutoResolveStrategies("git.run(['merge', '-X', 'ours', branch]);")).toHaveLength(1);
  });

  it('flags the joined -Xours and -Xtheirs forms', () => {
    expect(findAutoResolveStrategies("git.run(['merge', '-Xours', branch]);")).toHaveLength(1);
    expect(findAutoResolveStrategies("git.run(['merge', '-Xtheirs', branch]);")).toHaveLength(1);
  });

  it('flags the long forms', () => {
    expect(findAutoResolveStrategies("['merge', '--strategy=ours']")).toHaveLength(1);
    expect(findAutoResolveStrategies("['merge', '--strategy=theirs']")).toHaveLength(1);
    expect(findAutoResolveStrategies("['merge', '--strategy-option=ours']")).toHaveLength(1);
  });

  it('reports the line it found', () => {
    const source = ['const a = 1;', 'const b = 2;', "run(['merge', '-Xours']);"].join('\n');
    expect(findAutoResolveStrategies(source)[0]?.line).toBe(3);
  });

  it('does not flag the merge this repository really runs', () => {
    expect(
      findAutoResolveStrategies("return ['merge', '--no-ff', '-m', message, '--', branch];"),
    ).toEqual([]);
  });

  it('does not flag an unrelated -X-shaped word', () => {
    expect(findAutoResolveStrategies('const MAX = 1;\nconst prefix = "-Xcode";')).toEqual([]);
  });

  it('does not flag the prose that explains why the option is forbidden', () => {
    const source = [
      '/**',
      ' * There is deliberately no strategy option here: `-X ours`, `-X theirs`',
      ' * and `--strategy=ours` are blind auto-resolution.',
      ' */',
      "export const ARGS = ['merge', '--no-ff'];",
      '// never -Xtheirs',
    ].join('\n');
    expect(findAutoResolveStrategies(source)).toEqual([]);
  });
});

suite('stripComments', () => {
  it('keeps the line count stable, so a hit still reports where it is', () => {
    const source = ['/* a', ' b */', 'code(); // trailing', 'more();'].join('\n');
    expect(stripComments(source).split('\n')).toHaveLength(4);
  });

  it('removes a trailing line comment but keeps the code before it', () => {
    expect(stripComments('code(); // note').trim()).toBe('code();');
  });
});
