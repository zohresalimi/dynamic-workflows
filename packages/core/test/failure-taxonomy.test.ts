/**
 * KAR-02.10 — the failure taxonomy is the one in the architecture document,
 * and nothing in core turns a reason back into a class.
 *
 * The union in `packages/core/src/node-failure.ts` and the union in
 * docs/04-domain-model.md §8 are the same list or this fails. That is the only
 * way the two stay together: a reason added to the code without the document
 * is invisible to the next reader, and a reason added to the document without
 * the code is a failure the scheduler will meet as `internal` at 3am.
 *
 * The second half of the file is EPIC-02-S28's last scenario: `class` is
 * assigned where the failure is constructed, so a `classify(reason)` must not
 * exist for someone to reach for later.
 *
 * Verifies: EPIC-02-S28 · AC1, AC2
 */
import { expect, it, describe as suite } from 'vitest';
import { productionSources, readText } from '../../../test/support/workspace.ts';
import * as core from '../src/index.ts';
import { FAILURE_CLASSES, NODE_FAILURE_REASONS } from '../src/node-failure.ts';

/**
 * The literals of an `export type X = | "a" | "b";` block in the document.
 * Line comments are stripped first: §8 annotates most of its arms, and one of
 * those annotations contains a semicolon, which a naive scan for the
 * terminator would stop at.
 */
function unionLiteralsInDoc(markdown: string, typeName: string): string[] {
  const start = markdown.indexOf(`export type ${typeName} =`);
  expect(start, `${typeName} is not declared in docs/04-domain-model.md`).toBeGreaterThan(-1);

  const literals: string[] = [];
  let terminated = false;
  for (const line of markdown.slice(start).split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    for (const match of code.matchAll(/"([^"]+)"/g)) literals.push(match[1] as string);
    if (code.includes(';')) {
      terminated = true;
      break;
    }
  }
  expect(terminated, `${typeName}'s declaration is unterminated`).toBe(true);
  return literals;
}

suite('the taxonomy matches docs/04-domain-model.md §8 (AC1)', () => {
  const doc = readText('docs/04-domain-model.md');

  it('has exactly the reasons the document lists, in the document order', () => {
    expect(NODE_FAILURE_REASONS).toEqual(unionLiteralsInDoc(doc, 'NodeFailureReason'));
  });

  it('and that comparison is a real one, not an empty scan', () => {
    expect(unionLiteralsInDoc(doc, 'NodeFailureReason').length).toBeGreaterThan(20);
  });
});

suite('there is no classify(reason) in core (AC2, EPIC-02-S28)', () => {
  const sources = productionSources('packages/core');

  it('exports no function whose name promises a reason-to-class mapping', () => {
    const offenders = sources.flatMap((file) =>
      [...file.text.matchAll(/export (?:function|const) (\w+)/g)]
        .map((match) => match[1] as string)
        .filter((name) => /classif|deriveclass|classfor|reasontoclass/i.test(name))
        .map((name) => `${file.path}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('and no exported function turns a reason into a class when called with one', () => {
    expect(sources.length).toBeGreaterThan(0);
    const classes: readonly string[] = FAILURE_CLASSES;
    const offenders: string[] = [];

    for (const [name, exported] of Object.entries(core)) {
      if (typeof exported !== 'function') continue;
      for (const reason of NODE_FAILURE_REASONS) {
        let returned: unknown;
        try {
          returned = (exported as (value: unknown) => unknown)(reason);
        } catch {
          continue; // it rejected a bare reason string, which is the point
        }
        if (typeof returned === 'string' && classes.includes(returned)) {
          offenders.push(`${name}(${reason}) -> ${returned}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
