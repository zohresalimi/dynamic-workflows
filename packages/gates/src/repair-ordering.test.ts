/**
 * KAR-12.5 AC4 — the fix node's three steps are *observed*, not instructed.
 *
 * The whole mechanism is one reading of the branch: the first commit adds or
 * modifies a test, the gate at that commit fails, and a later commit makes it
 * pass. A fix node whose first commit already passes has not demonstrated
 * anything — it has asserted it, which is the shortcut §7 exists to make
 * visible.
 *
 * Verifies: EPIC-12-S29 (ordering half) · AC4
 */
import { expect, it, describe as suite } from 'vitest';
import {
  isTestPath,
  REPAIR_NO_FAILING_TEST,
  type RepairCommit,
  repairOrdering,
} from './repair-ordering.ts';

const commit = (sha: string, paths: readonly string[], outcome: RepairCommit['outcome']) =>
  ({ sha, paths, outcome }) satisfies RepairCommit;

suite('the ordering the branch actually shows (AC4)', () => {
  it('accepts a failing test then a fix', () => {
    const ordering = repairOrdering([
      commit('c1', ['packages/ui/test/DatePicker.test.ts'], 'fail'),
      commit('c2', ['packages/ui/src/DatePicker.vue'], 'pass'),
    ]);

    expect(ordering.ok).toBe(true);
    if (!ordering.ok) return;
    expect(ordering.testCommit).toBe('c1');
    expect(ordering.fixCommit).toBe('c2');
  });

  it('records repair.no_failing_test when the first commit already passes', () => {
    const ordering = repairOrdering([
      commit('c1', ['packages/ui/test/DatePicker.test.ts'], 'pass'),
      commit('c2', ['packages/ui/src/DatePicker.vue'], 'pass'),
    ]);

    expect(ordering.ok).toBe(false);
    if (ordering.ok) return;
    expect(ordering.code).toBe(REPAIR_NO_FAILING_TEST);
    expect(ordering.detail).toContain('passed');
  });

  it('records repair.no_failing_test when the first commit touches no test at all', () => {
    const ordering = repairOrdering([
      commit('c1', ['packages/ui/src/DatePicker.vue'], 'fail'),
      commit('c2', ['packages/ui/src/DatePicker.vue'], 'pass'),
    ]);

    expect(ordering.ok).toBe(false);
    if (ordering.ok) return;
    expect(ordering.code).toBe(REPAIR_NO_FAILING_TEST);
  });

  it('records repair.no_failing_test for a single commit that just fixes it', () => {
    const ordering = repairOrdering([commit('c1', ['packages/ui/src/DatePicker.vue'], 'pass')]);

    expect(ordering.ok).toBe(false);
    if (ordering.ok) return;
    expect(ordering.code).toBe(REPAIR_NO_FAILING_TEST);
  });

  it('refuses a branch with no commits rather than reading it as a pass', () => {
    const ordering = repairOrdering([]);

    expect(ordering.ok).toBe(false);
  });

  it('does not call it repaired while the last commit still fails', () => {
    const ordering = repairOrdering([
      commit('c1', ['packages/ui/test/DatePicker.test.ts'], 'fail'),
      commit('c2', ['packages/ui/src/DatePicker.vue'], 'fail'),
    ]);

    expect(ordering.ok).toBe(false);
    if (ordering.ok) return;
    expect(ordering.code).toBe('repair.still-failing');
  });

  it('lets the fix arrive two commits later', () => {
    const ordering = repairOrdering([
      commit('c1', ['packages/ui/test/DatePicker.test.ts'], 'fail'),
      commit('c2', ['packages/ui/src/DatePicker.vue'], 'fail'),
      commit('c3', ['packages/ui/src/DatePicker.vue'], 'pass'),
    ]);

    expect(ordering.ok).toBe(true);
    if (!ordering.ok) return;
    expect(ordering.fixCommit).toBe('c3');
  });

  it('accepts a first commit that modifies an existing test rather than adding one', () => {
    const ordering = repairOrdering([
      commit('c1', ['test/integration/date-picker.test.ts'], 'fail'),
      commit('c2', ['packages/ui/src/DatePicker.vue'], 'pass'),
    ]);

    expect(ordering.ok).toBe(true);
  });
});

suite('what counts as a test file', () => {
  it('recognises the shapes this repository actually uses', () => {
    for (const path of [
      'packages/ui/src/DatePicker.test.ts',
      'packages/ui/test/integration/thing.test.ts',
      'test/setup.test.ts',
      'e2e/dev-loop.test.ts',
      'src/__tests__/thing.ts',
      'packages/web/src/App.spec.ts',
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it('does not mistake production code for a test', () => {
    for (const path of [
      'packages/ui/src/DatePicker.vue',
      'packages/core/src/latest.ts',
      '.DeFlow/gates/typecheck.yaml',
      'docs/testing.md',
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it("takes the plan's own test globs when the caller supplies them", () => {
    expect(
      repairOrdering(
        [
          commit('c1', ['spec/date_picker_spec.rb'], 'fail'),
          commit('c2', ['app/date_picker.rb'], 'pass'),
        ],
        { testPaths: ['spec/**'] },
      ).ok,
    ).toBe(true);
  });
});
