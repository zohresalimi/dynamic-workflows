/**
 * KAR-19.2 AC3 and AC9 — one renderer, and an admission path that reads no
 * secret.
 *
 * KAR-18.8 already fought the wording argument and won it: every fact in
 * *"claude is not installed here"* was true and the first four words were
 * wrong, which is what stopped the rest of that report being trusted. A second,
 * friendlier sentence written for the daemon's refusal would be correct on the
 * day it was written and would drift within a month, so this is a scan of the
 * shipped tree rather than a note in a review.
 *
 * Two guards, for the two ways this story could go quietly wrong.
 *
 *  1. **One renderer.** Exactly one shipped module composes the "what is
 *     installed here, and what to run" sentence. `provider-availability.ts` is
 *     the one documented exception and it is not an install hint: it answers
 *     *"can a planned node route here"* from a probed row at plan time, with no
 *     `PATH` and no second binary to resolve, which is why it cannot delegate
 *     to `providerVerdict` and why reconciling the two is EPIC-05's and not
 *     this story's. The list has two entries; a third fails.
 *  2. **AR-1 on the admission path.** The modules that decide a submission
 *     read no credential file, no `*_TOKEN` and no `*_API_KEY`. An "is it
 *     logged in?" convenience check is exactly what somebody adds to make the
 *     refusal friendlier, and it is the one thing AR-1 forbids outright.
 *
 * Verifies: EPIC-19-S13 · KAR-19.2 AC3, AC9 · test plan #3, #9
 */
import { expect, it, describe as suite } from 'vitest';
import { MOCK_AGENT_SENTENCE } from '../packages/adapters/src/provider-install.ts';
import { packageProductionSources } from './support/workspace.ts';

/** The one module allowed to say what this machine has and what to install. */
const RENDERER_SEAM = 'packages/adapters/src/provider-install.ts';

/**
 * The plan-time availability sentence, which shares the phrase and answers a
 * different question. Documented rather than silently excluded, so that
 * merging the two is a decision somebody takes rather than one this list hides.
 */
const PLAN_TIME_AVAILABILITY = 'packages/adapters/src/provider-availability.ts';

/** Every module that participates in refusing a submission. */
const ADMISSION_PATH = [
  RENDERER_SEAM,
  'packages/daemon/src/providers/admission.ts',
  'packages/daemon/src/intake/intake.ts',
  'packages/daemon/src/http/run-refusal.ts',
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

function spelling(phrase: string): string[] {
  return sources.filter((file) => codeOnly(file.text).includes(phrase)).map((file) => file.path);
}

suite('AC3 — one renderer of the install sentence', () => {
  it('scans a tree that actually has sources in it, so an empty result means something', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.map((file) => file.path)).toContain(RENDERER_SEAM);
  });

  it('spells "is not installed here" in the seam and in one documented exception', () => {
    expect(spelling('is not installed here').toSorted()).toEqual(
      [RENDERER_SEAM, PLAN_TIME_AVAILABILITY].toSorted(),
    );
  });

  it('spells the adapter-missing sentence only in the seam', () => {
    expect(spelling('so this vendor CLI')).toEqual([RENDERER_SEAM]);
    expect(spelling('What is missing is its ACP adapter')).toEqual([RENDERER_SEAM]);
  });

  it('spells the `npm install -g <package>` template only in the seam', () => {
    // `installCommand` builds the string; nowhere else may interpolate a
    // provider package into one, which is how a second command with a
    // different flag order gets written.
    expect(spelling('npm install -g ${')).toEqual([RENDERER_SEAM]);
  });

  it('spells the mock-agent sentence only in the seam', () => {
    const fragment = 'no vendor CLI, no credential and no network';
    expect(MOCK_AGENT_SENTENCE).toContain(fragment);
    expect(spelling(fragment)).toEqual([RENDERER_SEAM]);
  });
});

suite('AC9 — the admission path reads no credential', () => {
  /** The homes of the three vendors' credential stores, and the two variable
   * name shapes a key arrives under. */
  const FORBIDDEN = [
    '.claude/',
    '.codex/',
    '.config/gcloud',
    '_TOKEN',
    '_API_KEY',
    'credentials',
    'auth.json',
  ] as const;

  it('has every admission module in the scanned tree', () => {
    for (const path of ADMISSION_PATH) {
      expect(
        sources.map((file) => file.path),
        `${path} is missing`,
      ).toContain(path);
    }
  });

  it.each(ADMISSION_PATH)('%s names no credential and no key variable', (path) => {
    const file = sources.find((candidate) => candidate.path === path);
    const code = codeOnly(file?.text ?? '').toLowerCase();
    for (const phrase of FORBIDDEN) {
      expect(code, `${path} names ${phrase}`).not.toContain(phrase.toLowerCase());
    }
  });
});
