/**
 * KAR-08.7 AC3 — the completion-time scope backstop has to be *reached*.
 *
 * The failure this guard exists for is not a wrong answer; it is a right
 * answer nobody asks for. `scope-diff.ts` can diff a worktree perfectly and
 * still never fire, because the thing that decides a node is finished —
 * `runAcpNode`, and the exec shim beside it — appends `node.completed` without
 * consulting it. That bug is invisible to every unit test the module has, it
 * looks like nothing at all in review, and the only symptom is a warning that
 * never appears.
 *
 * So the rule is stated where a grep can hold it, the same way
 * ./sandbox-boundaries.test.ts holds `shimPlan`: **a file that appends
 * `node.completed` is a file that audits the node's declared scope first.**
 * Adding a third node runner without wiring the backstop fails here, not in
 * production six months later.
 *
 * The second suite is the mirror image — `node.scope_warning` is appended in
 * exactly one place — so the audit cannot be quietly re-implemented beside the
 * chokepoint instead of through it.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import type { SourceFile } from './support/guards.ts';
import { allWorkspaceSources } from './support/workspace.ts';

/** Comments quote both names constantly — explaining the rule is how the next
 * reader understands it. Code is judged on its own. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const sources: readonly SourceFile[] = allWorkspaceSources();

/** Appending the node's terminal success record, as opposed to reading it:
 * `integration-loop.ts` compares `event.kind` against the string and must not
 * be caught by this. */
const APPENDS_COMPLETION = /\bevent\(\s*'node\.completed'/;
/** The one call that runs the backstop. Named, so the grep is exact. */
const RUNS_AUDIT = /\bauditCompletionScope\(/;
const NAMES_WARNING = /'node\.scope_warning'/;

const matching = (pattern: RegExp): string[] =>
  sources
    .filter((file) => pattern.test(codeOnly(file.text)))
    .map((file) => file.path)
    .toSorted();

suite('a node that completes has had its declared scope audited (AC3)', () => {
  it('found sources to check at all', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('there are node runners to guard in the first place', () => {
    // A guard whose subject has been renamed away passes vacuously and stays
    // green for ever. These two files are the node-completion authority.
    expect(matching(APPENDS_COMPLETION)).toEqual([
      'packages/adapters/src/run-node.ts',
      'packages/adapters/src/run-shim-node.ts',
    ]);
  });

  it('every file that appends node.completed calls the audit', () => {
    const unaudited = matching(APPENDS_COMPLETION).filter(
      (path) => !matching(RUNS_AUDIT).includes(path),
    );
    expect(unaudited).toEqual([]);
  });

  it('the guard would catch a node runner that skipped it', () => {
    const violating = codeOnly(
      "await ledger.append(event('node.completed', { node, attempt, result }));\n",
    );
    expect(APPENDS_COMPLETION.test(violating)).toBe(true);
    expect(RUNS_AUDIT.test(violating)).toBe(false);
  });

  it('the guard is not fooled by reading the event kind', () => {
    expect(APPENDS_COMPLETION.test("if (event.kind !== 'node.completed') continue;")).toBe(false);
  });
});

suite('the warning is written in exactly one place (AC5)', () => {
  it('only the audit chokepoint names node.scope_warning outside @DeFlow/core', () => {
    // @DeFlow/core is where the *kind* is declared — its schema table and its
    // reducer case. Everywhere else, naming the string means writing the event,
    // and there is one place allowed to do that.
    const writers = matching(NAMES_WARNING).filter(
      (path) => !path.startsWith('packages/core/src/'),
    );
    expect(writers).toEqual(['packages/adapters/src/scope-audit.ts']);
  });
});
