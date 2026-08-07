/**
 * KAR-14.1 — both Tier-1 dialects, read off the committed corpus, into one
 * `TokenUsage`.
 *
 * The corpus is what EPIC-14's Definition of Ready asks for and it is parsed
 * here rather than restated as an object literal, for the reason
 * `compact-boundary.test.ts` gives: a literal in a spec is the parser's own
 * author agreeing with themselves about what a vendor emits.
 *
 * What this file adds over `tier1-model-usage.test.ts` — which proves the
 * *differential* claim against inline fixtures — is that the **shapes agree**.
 * A rollup that reported Claude's spend and Codex's spend in two different
 * shapes would not be one rollup, and the failure would surface as a cost
 * chart that silently omits every Codex node.
 *
 * Verifies: EPIC-14-S1, EPIC-14-S2 · KAR-14.1 AC2 · test plan #6, #7
 */
import type { TokenUsage } from '@DeFlow/core';
import { TokenUsageSchema } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { parseShimLine, shimResultReport, turnCompletedReport } from '../src/index.ts';

const streamPath = (name: string): string =>
  fileURLToPath(new URL(`../../../test/fixtures/streams/${name}`, import.meta.url));

const linesOf = (name: string) =>
  readFileSync(streamPath(name), 'utf8')
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => parseShimLine(text))
    .filter((line) => line !== null);

const CLAUDE_STREAM = linesOf('compact-boundary.stream-json.jsonl');
const CODEX_STREAM = linesOf('codex-turn-completed.jsonl');

const claudeReport = CLAUDE_STREAM.map((line) => shimResultReport(line)).find(
  (report) => report !== null,
);
const codexReport = CODEX_STREAM.map((line) => turnCompletedReport(line)).find(
  (report) => report !== null,
);

suite('the Claude Code stream: modelUsage is read, usage is not (test plan #6)', () => {
  it('takes every figure off modelUsage[model]', () => {
    expect(claudeReport?.usage).toEqual({
      inputTokens: 84_210,
      outputTokens: 612,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 12,
      source: 'vendor-reported',
    });
    expect(claudeReport?.costUsd).toBeCloseTo(0.4213, 10);
  });

  it('reads the window off the turn, which is why no window table exists', () => {
    expect(claudeReport?.contextWindow).toBe(200_000);
    expect(claudeReport?.maxOutputTokens).toBe(32_000);
  });

  it('leaves the envelope’s own `usage` object untouched', () => {
    // The committed envelope carries a `usage` whose `cache_creation_input_
    // tokens` is 12 and whose `input_tokens` is 84210 — the same figures, by
    // construction, because the real CLI's agree. So the differential proof
    // lives in ./tier1-model-usage.test.ts, where they deliberately disagree.
    // What is assertable *here* is that the field is not part of the report's
    // vocabulary at all: nothing snake_cased survives into a `TokenUsage`.
    expect(Object.keys(claudeReport?.usage ?? {})).not.toContain('input_tokens');
    expect(TokenUsageSchema.safeParse(claudeReport?.usage).success).toBe(true);
  });
});

suite('the Codex stream: turn.completed carries the same shape (test plan #7)', () => {
  it('normalises the vendor’s own spelling into TokenUsage', () => {
    expect(codexReport?.usage).toEqual({
      inputTokens: 18_420,
      outputTokens: 2310,
      // `cached_input_tokens` on the wire; the same quantity, normalised.
      cacheReadInputTokens: 900,
      source: 'vendor-reported',
    });
  });

  it('reports no cost and no window, because the dialect reports neither', () => {
    expect(codexReport?.costUsd).toBeNull();
    expect(codexReport?.contextWindow).toBeNull();
    expect(codexReport?.maxOutputTokens).toBeNull();
  });
});

suite('the two dialects produce one shape, not two', () => {
  it('both parse as the same domain type, with the same source', () => {
    const usages: readonly (TokenUsage | undefined)[] = [claudeReport?.usage, codexReport?.usage];

    for (const usage of usages) {
      const parsed = TokenUsageSchema.safeParse(usage);
      expect(parsed.success).toBe(true);
      expect(usage?.source).toBe('vendor-reported');
    }
  });

  it('agrees on which keys a report has, so a rollup can fold both', () => {
    const keys = (report: typeof claudeReport) => Object.keys(report ?? {}).toSorted();

    expect(keys(claudeReport)).toEqual(keys(codexReport));
  });
});
