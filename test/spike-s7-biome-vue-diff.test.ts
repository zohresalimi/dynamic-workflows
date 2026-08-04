/**
 * KAR-00.6 — the arithmetic that turns `git diff --stat` output into a
 * bounded/not-bounded call, and the guards that keep the decision note
 * honest: a one-word verdict on `stage_fixed: true` for `.vue`, and the two
 * footgun cases (complex generics, long attribute lists) actually named.
 *
 * The real `biome check --write` / `oxlint` subprocess runs that produce the
 * diff live in test/integration/spike-s7-biome-vue.test.ts. This file is the
 * part with no business being a subprocess.
 *
 * Verifies: EPIC-00-S20 · AC2, AC3, AC4.
 */
import { expect, it, describe as suite } from 'vitest';
import { isBounded, parseDiffStatSummary } from '../spikes/s7-biome-vue/src/diff-stat.ts';
import { readVueStageFixedVerdict } from './support/guards.ts';
import { readText } from './support/workspace.ts';

const note = (): string => readText('docs/spikes/S7-biome-vue.md');

suite('parseDiffStatSummary reads the trailing summary line git diff --stat prints', () => {
  it('parses files changed, insertions and deletions together', () => {
    expect(parseDiffStatSummary(' 2 files changed, 14 insertions(+), 6 deletions(-)\n')).toEqual({
      filesChanged: 2,
      insertions: 14,
      deletions: 6,
    });
  });

  it('parses a single file with only insertions', () => {
    expect(parseDiffStatSummary(' 1 file changed, 3 insertions(+)\n')).toEqual({
      filesChanged: 1,
      insertions: 3,
      deletions: 0,
    });
  });

  it('parses a single file with only deletions', () => {
    expect(parseDiffStatSummary(' 1 file changed, 1 deletion(-)\n')).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 1,
    });
  });

  it('reads the last non-blank line, ignoring the per-file lines above it', () => {
    const output =
      ' complex-generics.vue | 12 +++++++-----\n' +
      ' long-attrs.vue       |  6 ++++--\n' +
      ' 2 files changed, 14 insertions(+), 4 deletions(-)\n';
    expect(parseDiffStatSummary(output).filesChanged).toBe(2);
  });

  it('throws rather than silently reporting zero when there is no summary line', () => {
    expect(() => parseDiffStatSummary('')).toThrow(/no "files changed" summary line/);
    expect(() => parseDiffStatSummary('\n  \n')).toThrow(/no "files changed" summary line/);
  });
});

suite('isBounded compares a diff total against a real threshold (AC2)', () => {
  it('accepts a total at or under the threshold', () => {
    expect(isBounded({ filesChanged: 2, insertions: 10, deletions: 5 }, 15)).toBe(true);
    expect(isBounded({ filesChanged: 2, insertions: 10, deletions: 5 }, 20)).toBe(true);
  });

  it('rejects a total over the threshold', () => {
    expect(isBounded({ filesChanged: 2, insertions: 10, deletions: 5 }, 14)).toBe(false);
  });
});

suite('the decision note records a one-word verdict on stage_fixed (AC4)', () => {
  it("states a verdict that test/git-hooks.test.ts's own reader can parse as safe or not-safe", () => {
    // The parser is test/support/guards.ts's readVueStageFixedVerdict — the
    // same function test/git-hooks.test.ts uses to decide whether the
    // lefthook.yml format glob is allowed to include .vue. Using it here
    // rather than a second, hand-rolled regex is what keeps the two in sync.
    expect(readVueStageFixedVerdict(note())).not.toBe('unrecorded');
  });
});

suite('the note demonstrates the silent no-op before assuming it, and corrects it (AC1)', () => {
  it('records that the html block absent left the <template> markup byte-for-byte identical', () => {
    const text = note();
    expect(text).toMatch(/html.{0,40}absent/is);
    expect(text).toMatch(/byte-for-byte identical/i);
  });

  it("records that the .vue file was not fully untouched, correcting the epic's assumption", () => {
    // Measured: the <script> block is reformatted by Biome's ordinary TS
    // formatter regardless of the html flag, so "zero changed .vue files" as
    // literally stated in the epic's AC1 does not hold for Biome 2.5.6. A
    // spike that discovers its premise was wrong has to say so, not report
    // the assumption as if it measured it.
    expect(note()).toMatch(/not (fully )?untouched|does not hold|needed a correction/i);
  });
});

suite('the note quotes a bounded git diff --stat total (AC2)', () => {
  it('quotes the files-changed summary from the real biome run', () => {
    expect(note()).toMatch(/\d+ files? changed, \d+ insertions?\(\+\)/);
  });
});

suite('the review specifically covers the two footgun cases (AC3)', () => {
  it('names complex generics in a <script setup> block', () => {
    expect(note()).toMatch(/script setup/i);
    expect(note()).toMatch(/generic/i);
  });

  it('names a long attribute list in a template', () => {
    expect(note()).toMatch(/long attribute list/i);
  });
});

suite('the ownership split is confirmed, not merely configured (AC5)', () => {
  it('records that a diagnostic appeared twice with the linter enabled', () => {
    expect(note()).toMatch(/appear(?:s|ed)? twice/i);
  });

  it('records that oxlint saw nothing for the template-only unused component', () => {
    expect(note()).toMatch(/no-unused-components/);
    expect(note()).toMatch(/oxlint/i);
  });
});
