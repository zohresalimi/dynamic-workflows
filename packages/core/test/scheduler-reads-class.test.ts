/**
 * KAR-06.5 AC1 / EPIC-06-S18 (third scenario) — the scheduler never branches on
 * `reason`.
 *
 * The rule is worth a structural test rather than a code review because the
 * violation is invisible at the point it is written and expensive only later:
 * `provider.unavailable` is transient for a rate-limited vendor and permanent
 * for a binary the user uninstalled mid-run, and a scheduler that decides from
 * the reason collapses the two. The classifier assigns `class` when the
 * `NodeFailure` is constructed, because that is the only place the context
 * exists.
 *
 * The story's acceptance criterion names `packages/orchestrator/src`. This repo
 * has no such package — docs/16-repo-layout.md puts the scheduler's pure half in
 * `@DeFlow/core` (`decide.ts`, `retry.ts`) and its imperative shell in
 * `@DeFlow/daemon` (`retry.ts`, `ticker.ts`) — so the scan covers those files by
 * name and fails if one of them disappears, which is the same guarantee spelled
 * for the layout that exists.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkSchedulerBranchesOnClassOnly,
  describe as render,
  type SourceFile,
} from '../../../test/support/guards.ts';
import { readSources } from '../../../test/support/workspace.ts';
import { NODE_FAILURE_REASONS } from '../src/node-failure.ts';

/** Every module that decides what a failure *means*. */
const SCHEDULER_SOURCES = [
  'packages/core/src/decide.ts',
  'packages/core/src/retry.ts',
  'packages/daemon/src/retry.ts',
  'packages/daemon/src/ticker.ts',
];

/** The one module allowed to name a reason: where `class` is assigned. */
const CLASSIFIER = ['packages/core/src/node-failure.ts'];

const sources = (): SourceFile[] => readSources([...SCHEDULER_SOURCES, ...CLASSIFIER]);

suite('the scheduler reads class and nothing else (AC1)', () => {
  it('scans every scheduling module named by the layout', () => {
    expect(
      sources()
        .map((file) => file.path)
        .sort(),
    ).toEqual([...SCHEDULER_SOURCES, ...CLASSIFIER].sort());
  });

  it('finds no NodeFailureReason literal outside the classifier', () => {
    expect(
      render(checkSchedulerBranchesOnClassOnly(sources(), NODE_FAILURE_REASONS, CLASSIFIER)),
    ).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    const mutated = sources().map((file) => ({
      ...file,
      text: `${file.text}\nconst hidden = failure.reason === 'provider.rate-limited';\n`,
    }));
    // Every file but the exempt classifier objects.
    expect(
      checkSchedulerBranchesOnClassOnly(mutated, NODE_FAILURE_REASONS, CLASSIFIER).length,
    ).toBe(SCHEDULER_SOURCES.length);
  });

  it('does not object to matching a plan-supplied reason against a failure', () => {
    const dataDriven: SourceFile[] = [
      {
        path: 'packages/core/src/retry.ts',
        text: 'const override = onFailure.find((entry) => entry.when === failure.reason);\n',
      },
    ];
    expect(checkSchedulerBranchesOnClassOnly(dataDriven, NODE_FAILURE_REASONS, CLASSIFIER)).toEqual(
      [],
    );
  });
});
