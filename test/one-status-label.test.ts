/**
 * KAR-19.1 AC6 — *"the status string is produced by one function in
 * `@DeFlow/core` and rendered by three callers, not derived three times."*
 *
 * On 2026-08-12 `deflow run` said `task submitted`, `deflow status` said
 * `created — no nodes yet` and the web UI said `No plan yet` about the same run
 * at the same head sequence. Each was written by somebody with a defensible
 * local reason, and the operator's conclusion — reasonably — was that the
 * problem must be somewhere they had not looked.
 *
 * A convention would not have prevented that and will not prevent the next one,
 * so this is a scan of the shipped tree rather than a note in a review:
 *
 *  1. Exactly one module defines the vocabulary, and it is in `@DeFlow/core`.
 *  2. No other shipped source spells one of the labels as a literal — which is
 *     what a fourth wording looks like on the day it is written.
 *  3. The three surfaces named in AC6 all reach the shared table.
 *  4. The three sentences the incident produced appear nowhere at all.
 *
 * Verifies: EPIC-19-S7 · KAR-19.1 AC6 · test plan #6
 */
// A relative import rather than the package name: `test/` is the repository's
// own tree and resolves no workspace dependency, which is also why it is the
// right place for a guard that reads the workspace as text.

import { expect, it, describe as suite } from 'vitest';
import { RUN_STATUS_LABELS } from '../packages/core/src/run-status-label.ts';
import { packageProductionSources } from './support/workspace.ts';

/** The one module allowed to spell a run status label. */
const LABEL_SEAM = 'packages/core/src/run-status-label.ts';

/** The surfaces AC6 names, and the file in each that has to reach the seam. */
const CALLERS = [
  'packages/cli/src/status.ts',
  'packages/cli/src/run/render.ts',
  'packages/daemon/src/http/run-list.ts',
  'packages/web/src/stores/useRunListStore.ts',
] as const;

const sources = packageProductionSources().filter((file) => !file.path.endsWith('.test.ts'));

/** Whole-line comments blanked, so the doc comment explaining the rule is not
 * the rule's first violation. Line count is preserved. */
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

suite('AC6 — one producer of the run status string', () => {
  it('scans a tree that actually has sources in it, so an empty result means something', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.map((file) => file.path)).toContain(LABEL_SEAM);
  });

  it('spells every label in exactly one shipped module', () => {
    // The one-word labels — `running`, `paused`, `completed` — are ordinary
    // English that a hundred unrelated lines legitimately contain, so the scan
    // is over the ones that are *sentences*: a second wording always arrives as
    // one of these, because a one-word status is not what anybody rewrites.
    const sentences = Object.values(RUN_STATUS_LABELS).filter((label) => label.includes(' '));
    expect(sentences.length).toBeGreaterThanOrEqual(3);

    for (const label of sentences) {
      const spelled = sources
        .filter((file) => codeOnly(file.text).includes(label))
        .map((file) => file.path);
      expect(spelled, `"${label}" is spelled outside ${LABEL_SEAM}`).toEqual([LABEL_SEAM]);
    }
  });

  it('has each of AC6’s surfaces reaching the shared table rather than its own', () => {
    for (const path of CALLERS) {
      const file = sources.find((candidate) => candidate.path === path);
      expect(file, `${path} is not in the scanned tree`).toBeDefined();
      expect(file?.text, `${path} does not reach @DeFlow/core's label`).toMatch(
        /runStatusLabel|RUN_STATUS_LABELS/,
      );
    }
  });

  it('never prints the three sentences the incident produced', () => {
    const banned = ['no nodes yet', 'No plan yet'];
    for (const phrase of banned) {
      const spelled = sources
        .filter((file) => codeOnly(file.text).includes(phrase))
        .map((file) => file.path);
      expect(spelled, `"${phrase}" survived KAR-19.1`).toEqual([]);
    }
  });
});
