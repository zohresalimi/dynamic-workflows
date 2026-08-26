/**
 * KAR-27.6 AC2, AC6 — *"every surface that shows it also names forceful cancel
 * as the operator's next move"*, and *"`deflow status` and the API report the
 * same waiting state in the same words."*
 *
 * "The same words" is not something a behavioural spec can hold for long. Three
 * surfaces render this state — the run list the UI draws, `deflow status`, and
 * `GET /api/runs/:id` — and the day one of them composes its own sentence, both
 * halves of AC6 are false and every per-surface test still passes, because each
 * one asserts its own copy. That is exactly how `created — no nodes yet`,
 * `task submitted` and `No plan yet` came to describe one run three ways
 * (KAR-19.1 AC6, `./one-status-label.test.ts`), and this is the same guard one
 * field further in.
 *
 * So the vocabulary lives in one module and this is a scan of the shipped tree
 * rather than a note in a review:
 *
 *  1. `packages/core/src/cooperative-cancel.ts` is the only shipped source that
 *     spells the waiting sentence or the `--force` remedy.
 *  2. Every surface AC6 names reaches it, rather than deriving one.
 *
 * `docs/` is out of scope on purpose: the epic and its flows quote the sentence
 * because they specify it.
 *
 * Verifies: EPIC-27-S29 · KAR-27.6 AC2, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { allWorkspaceSources } from './support/workspace.ts';

/** The one module allowed to spell the waiting vocabulary. */
const SEAM = 'packages/core/src/cooperative-cancel.ts';

/**
 * The two shapes a second wording arrives as.
 *
 * The first is the waiting sentence itself. The second is the remedy *built for
 * a particular run* — `deflow cancel ${runId} --force` — which is what makes it
 * a second producer rather than prose: `--force` on its own is an ordinary word
 * here (`git push --force` is what `destructive-command.ts` is about, and
 * `deflow cancel <runId> [--force]` is the command's own usage line), and a rule
 * that banned it would be a rule nobody could keep.
 */
const PHRASES: readonly (string | RegExp)[] = [
  'the agent has not answered since',
  /deflow cancel \$\{[^}]*\}[^\n]*--force/,
];

/** The surfaces AC2 and AC6 name, and the file in each that has to reach the seam. */
const SURFACES = [
  'packages/cli/src/status.ts',
  'packages/cli/src/cancel.ts',
  'packages/daemon/src/http/run-list.ts',
  'packages/daemon/src/http/api.ts',
  'packages/web/src/views/RunListView.vue',
] as const;

const sources = allWorkspaceSources();

/** Whole-line comments blanked, so the doc comment explaining the rule is not
 * the rule's first violation. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('<!--')
        ? ''
        : line;
    })
    .join('\n');
}

suite('AC2, AC6 — one producer of the parked-cancel sentence', () => {
  it('scans a tree that actually has sources in it, so an empty result means something', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.map((file) => file.path)).toContain(SEAM);
  });

  it('spells the waiting sentence and the way out in exactly one shipped module', () => {
    for (const phrase of PHRASES) {
      const spelled = sources
        .filter((file) => {
          const code = codeOnly(file.text);
          return typeof phrase === 'string' ? code.includes(phrase) : phrase.test(code);
        })
        .map((file) => file.path);
      expect(spelled, `${String(phrase)} is spelled outside ${SEAM}`).toEqual([SEAM]);
    }
  });

  it('has every surface that shows the wait reaching the shared vocabulary', () => {
    for (const path of SURFACES) {
      const file = sources.find((candidate) => candidate.path === path);
      expect(file, `${path} is not in the scanned tree`).toBeDefined();
      // Either half of the seam counts: the run list, `deflow status` and the
      // run view render a whole `CancelWaiting`, while `deflow cancel` — which
      // is answering a cancel it has just made and has no projection to hand —
      // reaches only for the command.
      expect(file?.text, `${path} does not reach the parked-cancel vocabulary`).toMatch(
        /cancelWaiting|CancelWaiting|forcefulCancelCommand/,
      );
    }
  });
});
