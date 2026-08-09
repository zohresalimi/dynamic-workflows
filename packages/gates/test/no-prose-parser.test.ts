/**
 * KAR-12.3 — there is no regex-based verdict extractor in this package, and
 * there is no place one could hide.
 *
 * [docs/10-verification-gates.md §10] is explicit: _"parsing findings out of
 * prose breaks on the next CLI release."_ The schema is enforced at the adapter
 * boundary — a native `--json-schema` / `--output-schema` flag, then Ajv — and
 * the honest degradation when a provider cannot do that is a node that fails
 * with `contract.schema-invalid` and a capability row that says
 * `structuredOutput: false`, so the planner stops routing gates there. It is
 * **not** a fallback that reads a verdict out of a paragraph, because such a
 * fallback works in the demo, works for a month, and then silently produces
 * half a verdict on the day the vendor reflows its output.
 *
 * The seven *tool* parsers are a different thing and are deliberately not
 * matched here: they read `tsc`, oxlint, biome and JUnit output, which are
 * machine formats a tool promises, not prose a model wrote.
 *
 * Verifies: EPIC-12-S19 (second scenario)
 */
import { expect, it, describe as suite } from 'vitest';
import { productionSources } from '../../../test/support/workspace.ts';

const sources = productionSources('packages/gates');

/**
 * What a prose extractor looks like: a regular expression, or a hand-rolled
 * scan, applied to something calling itself a verdict, a review, a judgement or
 * a model's text.
 */
const PROSE_EXTRACTOR =
  /\b(verdict|review|judgement|judgment|reviewer|completion|assistantText|responseText)\w*\s*\.\s*(match|matchAll|exec|search|split)\b/i;

/** The other spelling: a named function whose job is to read a verdict out of
 * text. */
const EXTRACTOR_NAME =
  /\b(parse|extract|scrape|recover|salvage|infer)(Verdict|Findings?FromText|FromProse|FromOutput)\b/i;

suite('the package has sources to assert over', () => {
  it('found them', () => {
    expect(sources.length).toBeGreaterThan(5);
  });
});

suite('no prose fallback parser exists in packages/gates (S19, second scenario)', () => {
  for (const file of sources) {
    it(`${file.path} reads no verdict out of prose`, () => {
      const hits = file.text
        .split('\n')
        .map((line, index) => ({ line: index + 1, text: line.trim() }))
        // Comments are where this rule is *explained*; the assertion is about
        // code, and a comment naming the forbidden thing is the documentation
        // working rather than the rule being broken.
        .filter((entry) => !entry.text.startsWith('*') && !entry.text.startsWith('//'))
        .filter((entry) => PROSE_EXTRACTOR.test(entry.text) || EXTRACTOR_NAME.test(entry.text));

      expect(hits).toEqual([]);
    });
  }
});
