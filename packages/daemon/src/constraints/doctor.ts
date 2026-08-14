/**
 * KAR-09.4 AC4 — the constraint section of `deflow doctor`.
 *
 * The command itself is EPIC-18 (KAR-18.4); this module holds the policy ahead
 * of it existing, the same split `../tokens/doctor.ts` already uses for the
 * calibration section and `../proc/auth-shadow.ts` for the auth check.
 *
 * **Why a ratio is worth a line.** docs/08-context-and-memory.md §4.2: `forbid`
 * exists because some constraints genuinely have no closed positive form, and
 * *"a rising `forbid` ratio in a run's spec is a leading indicator of the decay
 * this section exists to prevent"*. The decay in question — omission compliance
 * falling from 73% at turn 5 to 33% at turn 16 — is invisible to ordinary
 * monitoring, because the commission-type audit signals stay healthy the whole
 * way down. A number nobody prints is a number nobody sees move.
 *
 * **A convertible `forbid` is named, not failed.** EPIC-09-S22's fourth
 * scenario: a prohibition over write paths, for which an `allow-only` form
 * exists, is a review smell. The build succeeds; the report says which one,
 * because "your forbid ratio is 3" is not actionable and "`forbid write-path`
 * has a positive form" is.
 */
import {
  type Constraint,
  configuredConstraints,
  convertibleForbids,
  countConstraintForms,
  forbidRatio,
  pinnedConstraintsOf,
  type TaskSpec,
} from '@DeFlow/core';
import { loadWorkspaceConfig } from '../config/workspace-config.ts';

/** Two decimal places at most, and no trailing zeros: a ratio is a signal, and
 * printing it to fifteen places hides the interesting digits. */
const formatRatio = (ratio: number): string =>
  ratio.toFixed(2).replace(/\.?0+$/, '') === ''
    ? '0'
    : ratio.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

/** The whole section, as `deflow doctor` will print it. */
export function renderConstraintReport(constraints: readonly Constraint[]): string {
  if (constraints.length === 0) {
    return 'pinned constraints: no constraints are declared for this spec.';
  }

  const counts = countConstraintForms(constraints);
  const ratio = forbidRatio(counts);
  const census = `${counts.allowOnly} allow-only, ${counts.require} require, ${counts.forbid} forbid`;

  const lines = [`pinned constraints: ${census}.`];
  lines.push(
    ratio === null
      ? '  forbid-to-allow-only ratio: no allow-only constraints are declared, so there is no ' +
          'ratio yet. Prohibitions decay with turn depth while positive requirements do not ' +
          '(docs/08-context-and-memory.md §4.2), so a spec made entirely of prohibitions is the ' +
          'worst starting point for constraint decay.'
      : `  forbid-to-allow-only ratio: ${formatRatio(ratio)} (${counts.forbid} forbid / ` +
          `${counts.allowOnly} allow-only). A rising ratio is a leading indicator of constraint ` +
          'decay: omission compliance falls with turn depth while commission compliance holds ' +
          '(docs/08-context-and-memory.md §4.2).',
  );

  const convertible = convertibleForbids(constraints);
  if (convertible.length > 0) {
    lines.push(
      `  convertible: ${convertible
        .map((constraint) => `forbid ${constraint.subject}`)
        .join(', ')} — each of these has a closed allow-only form and would survive turn depth ` +
        'better as one. Not an error; a review note.',
    );
  }
  return lines.join('\n');
}

/**
 * The same report for a workspace: the run-config constraints from
 * `.DeFlow/config.yaml` plus the spec's own prose constraints, composed exactly
 * as the packet builder composes them.
 *
 * `pinnedConstraintsOf` rather than a second list: the number the doctor prints
 * has to be the number that will be pinned, or the report describes a spec
 * nobody is running.
 */
export function workspaceConstraintReport(cwd: string, spec?: TaskSpec): string {
  const constraints = configuredConstraints(loadWorkspaceConfig(cwd));
  return renderConstraintReport(
    spec === undefined ? constraints : pinnedConstraintsOf(spec, constraints),
  );
}
