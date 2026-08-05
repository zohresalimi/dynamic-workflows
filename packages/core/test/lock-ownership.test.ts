/**
 * KAR-06.2 AC3 / EPIC-06-S6 scenario 3 — lock ownership lives in the ledger and
 * nowhere else.
 *
 * `node.lock.acquired` / `node.lock.released` are the **only** record of who
 * holds what. The reason this is a source scan rather than a behavioural test
 * is the reason the scenario gives out loud: the in-memory version is so much
 * easier to write that it will be written unless something fails when it is.
 * A `Map<string, NodeId>` at module scope passes every unit test in
 * ../src/decide.test.ts — right up to the restart the lock exists for, at which
 * point it is empty and several write nodes resume into the same git index.
 *
 * The scan covers the scheduler wherever it lives: `decide` and its lock
 * derivation today, plus `packages/orchestrator/src` from the story that
 * creates it (KAR-06.3), so the guard does not quietly stop covering the code
 * the moment the imperative shell arrives.
 *
 * Verifies: EPIC-06-S6 (scenario 3) · AC3
 */
import { expect, it, describe as suite } from 'vitest';
import type { SourceFile } from '../../../test/support/guards.ts';
import { productionSources, readSources, walk } from '../../../test/support/workspace.ts';

/** The scheduler's own sources: the pure policy, plus the shell once it exists. */
function schedulerSources(): SourceFile[] {
  const core = productionSources('packages/core').filter((file) =>
    /\/(decide|locks)\.ts$/.test(file.path),
  );
  const orchestrator = readSources(
    walk('packages/orchestrator/src', (path) => path.endsWith('.ts') && !path.endsWith('.test.ts')),
  );
  return [...core, ...orchestrator];
}

/**
 * The file with its comments removed. The guards below are rules about code,
 * and these files are heavily commented about locks — a scan that reads the
 * prose reports the section heading and nothing real.
 */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Lines outside every function body — module scope, where a cache would live. */
function moduleScopeLines(text: string): string[] {
  const lines: string[] = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    if (depth === 0) lines.push(line);
    for (const character of line) {
      if (character === '{') depth += 1;
      else if (character === '}') depth = Math.max(0, depth - 1);
    }
  }
  return lines;
}

suite('the lock derivation is a module of its own, so the guard has something to point at', () => {
  it('finds packages/core/src/locks.ts', () => {
    expect(schedulerSources().map((file) => file.path)).toContain('packages/core/src/locks.ts');
  });
});

suite('no scheduler source holds lock state outside the ledger (AC3)', () => {
  it('scans a non-trivial number of files, so it cannot pass vacuously', () => {
    expect(schedulerSources().length).toBeGreaterThanOrEqual(2);
  });

  for (const file of schedulerSources()) {
    it(`${file.path} declares no module-scope Map or Set`, () => {
      const declarations = moduleScopeLines(codeOnly(file.text)).filter((line) =>
        /\bnew (Map|Set|WeakMap|WeakSet)\b/.test(line),
      );

      expect(
        declarations,
        'a module-scope Map or Set evaporates on restart, which is the one moment the lock matters',
      ).toEqual([]);
    });

    it(`${file.path} declares no mutable module-scope binding`, () => {
      const mutable = moduleScopeLines(codeOnly(file.text)).filter((line) =>
        /^(let|var)\s/.test(line),
      );

      expect(mutable).toEqual([]);
    });

    it(`${file.path} reads held locks only out of reduced state`, () => {
      // Every mention of `locks` in the scheduler must be a property of a
      // `RunState`. A bare `locks` identifier is a local copy, and a local copy
      // is a second home for a fact that is only allowed one. String literals
      // go first, so the module specifier `'./locks.ts'` is not read as one.
      const code = codeOnly(file.text).replace(/'[^']*'/g, "''");
      const mentions = [...code.matchAll(/(^|[^\w.])locks\b/gm)].map((match) => match[0]);

      expect(mentions, `${file.path} names \`locks\` other than as \`state.locks\``).toEqual([]);
    });
  }
});

suite('the reducer is the only writer of lock ownership', () => {
  it('assigns RunState.locks in reduce.ts and nowhere else', () => {
    const writers = productionSources('packages/core')
      .concat(productionSources('packages/ledger'))
      .concat(productionSources('packages/daemon'))
      .filter(
        (file) => /\blocks:\s/.test(codeOnly(file.text)) && !file.path.endsWith('run-state.ts'),
      );

    expect(writers.map((file) => file.path)).toEqual(['packages/core/src/reduce.ts']);
  });
});
