/**
 * KAR-11.2 AC9 / EPIC-11-S12, second scenario — there is exactly one entry
 * point to plan persistence, and it cannot run without a `Diagnostic[]`.
 *
 * This is the assertion the epic's own notes say is the point of the story:
 * *"v1 validation is the obvious case, but the patch that adds a node reading a
 * key nothing writes is the one that actually bites, because it happens at node
 * 27 of 40"*, and AC9's structural check *"is what keeps that true after six
 * months of edits, when someone adds a 'quick' second write path"*.
 *
 * Three facts hold it, and each one fails differently if it stops being true:
 *
 *  1. **One `INSERT INTO plan`.** A second one anywhere in the workspace is a
 *     write path that never saw a diagnostic, however well-intentioned.
 *  2. **`persistPlanVersion` demands `diagnostics`, and the field is not
 *     optional.** A caller that has not validated cannot construct the
 *     argument, so the failure is a compile error rather than an unvalidated
 *     plan in the ledger.
 *  3. **The daemon reaches it only through the validating wrappers.** Both
 *     call sites — `compilePlanV1` for `plan.proposed` and `commitPatchedPlan`
 *     for a patched successor — run `validatePlanVersion` first, which is
 *     KAR-11.2's own single entry point.
 *
 * The fourth suite is the epic's Definition of Done grep, and it belongs beside
 * these because it guards the same class of regression: D13's flat branch
 * scheme is a *verified* bug fix, and `DeFlow/<runId>/<nodeId>` is exactly the
 * shape somebody tidying up branch names reintroduces.
 *
 * Verifies: EPIC-11-S12 (second scenario), EPIC-11-S10 (fourth scenario) ·
 * AC7, AC9
 */
import { expect, it, describe as suite } from 'vitest';
import { describe as render } from './support/guards.ts';
import { packageProductionSources, readText } from './support/workspace.ts';

/** The one module allowed to write the content-addressed plan table. */
const PLAN_WRITE_SEAM = 'packages/ledger/src/plans.ts';

const sources = packageProductionSources();

/**
 * Whole-line comments blanked out, so a doc comment explaining the rule is not
 * the rule's own first violation. Line count is preserved.
 */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

const INSERT_INTO_PLAN = /INSERT\s+INTO\s+plan\b/i;

suite('AC9 — exactly one code path inserts into the plan table', () => {
  it('scans the whole runtime tree, so an empty result would mean something', () => {
    expect(sources.length).toBeGreaterThan(80);
    expect(sources.map((file) => file.path)).toContain(PLAN_WRITE_SEAM);
  });

  it('names the seam and nothing else', () => {
    const offenders = sources
      .filter((file) => INSERT_INTO_PLAN.test(codeOnly(file.text)))
      .map((file) => file.path);

    expect(offenders).toEqual([PLAN_WRITE_SEAM]);
  });

  it('and that seam requires a diagnostics array it cannot default away', () => {
    const seam = readText(PLAN_WRITE_SEAM);

    // Required, not `diagnostics?:` and not `diagnostics = []`. The type is the
    // mechanism: a caller that has not validated cannot satisfy it.
    expect(seam).toContain('readonly diagnostics: readonly PlanDiagnostic[];');
    expect(seam).not.toContain('readonly diagnostics?:');
    expect(seam).toContain('hasBlockingDiagnostic(options.diagnostics)');
  });
});

suite('AC9 — both persistence call sites validate first', () => {
  /**
   * The seam has two entry points — `persistPlanVersion` for a proposed
   * version and KAR-11.3's `applyPatchedPlanVersion` for a patched successor —
   * and both take the same non-optional `diagnostics`. A caller of either is a
   * plan write, so both names are what this scan looks for.
   */
  const ENTRY_POINTS = ['persistPlanVersion(', 'applyPatchedPlanVersion('];

  const callers = sources.filter(
    (file) =>
      file.path !== PLAN_WRITE_SEAM &&
      ENTRY_POINTS.some((entry) => codeOnly(file.text).includes(entry)),
  );

  it('finds the two the daemon has, and no third', () => {
    expect(callers.map((file) => file.path).toSorted()).toEqual([
      'packages/daemon/src/plan/compile.ts',
      'packages/daemon/src/plan/validate.ts',
    ]);
  });

  it('each of them produces the diagnostics through validatePlanVersion', () => {
    const violations = callers
      .filter((file) => !codeOnly(file.text).includes('validatePlanVersion('))
      .map((file) => ({
        where: file.path,
        message:
          'calls persistPlanVersion without going through validatePlanVersion, so this plan ' +
          'version would be persisted against a diagnostics array nothing produced.',
      }));

    expect(render(violations)).toBe('');
  });
});

/**
 * KAR-11.3 AC5 / EPIC-11-S14, second scenario — *"a CI assertion proves the
 * only statements issued against the plan table are INSERT and SELECT"*.
 *
 * The companion to the suite above, and a different guarantee: that one names
 * the single place a plan row is *written*, this one says the write is only
 * ever an append. 06 §8: *"do not mutate a plan row in place. Ever. The
 * scrubber, replay, and every 'why' question depend on old versions being
 * byte-identical to what actually ran."* A patched version is a new row —
 * `applyPatchedPlanVersion` updates `run.plan_hash`, which is a projection, and
 * never the document the old hash addresses.
 */
suite('AC5 — the plan table is INSERT and SELECT, and nothing else', () => {
  const UPDATE_PLAN = /\bUPDATE\s+plan\b/i;
  const DELETE_PLAN = /\bDELETE\s+FROM\s+plan\b/i;

  it('finds no statement that would mutate or remove a plan version', () => {
    const offenders = sources
      .filter((file) => {
        const code = codeOnly(file.text);
        return UPDATE_PLAN.test(code) || DELETE_PLAN.test(code);
      })
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('and that is a real result: the patterns match what they ban', () => {
    expect(UPDATE_PLAN.test('UPDATE plan SET doc = ? WHERE hash = ?')).toBe(true);
    expect(DELETE_PLAN.test('DELETE FROM plan WHERE run_id = ?')).toBe(true);
    // The two statements the applier really does issue against a *projection*
    // stay legal — `run.plan_hash` is rebuildable from the event log, and the
    // column name must not be mistaken for the table.
    expect(UPDATE_PLAN.test('UPDATE run SET plan_hash = ? WHERE run_id = ?')).toBe(false);
    expect(DELETE_PLAN.test('DELETE FROM plan_cache WHERE run_id = ?')).toBe(false);
  });

  it('and the seam really does issue the two that are allowed', () => {
    const seam = codeOnly(readText(PLAN_WRITE_SEAM));

    expect(INSERT_INTO_PLAN.test(seam)).toBe(true);
    expect(seam).toContain('SELECT doc FROM plan WHERE hash = ?');
  });
});

suite("AC7 — no source composes the PRD's nested branch scheme (epic DoD grep)", () => {
  /**
   * `DeFlow/` followed by an interpolation and then a `/`. D13's scheme puts
   * `__` there instead, and the difference is whether `refs/heads/DeFlow/<runId>`
   * has to be both a file and a directory — which git will not do.
   */
  const NESTED_BRANCH = /['"`]DeFlow\/\$\{[^}]+\}\//;

  it('finds none, anywhere in the runtime tree', () => {
    const offenders = sources
      .filter((file) => NESTED_BRANCH.test(codeOnly(file.text)))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('and that is a real result: the pattern matches the shape it bans', () => {
    expect(NESTED_BRANCH.test('`DeFlow/${runId}/${nodeId}`')).toBe(true);
    expect(NESTED_BRANCH.test('`DeFlow/${runId}__${nodeId}`')).toBe(false);
    // The two prefixed forms DeFlow really does use stay legal, because the
    // segment after `DeFlow/` is a literal and cannot collide with a node
    // branch's file name.
    expect(NESTED_BRANCH.test('`DeFlow/int/${runId}`')).toBe(false);
    expect(NESTED_BRANCH.test('`DeFlow/salvage/${runId}__${nodeId}`')).toBe(false);
  });
});
