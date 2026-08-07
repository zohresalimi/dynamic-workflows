/**
 * KAR-09.7 Tier 1 — the authoritative post-hoc figures, and the field that
 * looks like them and is not.
 *
 * `usage` is typed `z.unknown()` in the CLI's own zod schema — *"a raw
 * passthrough whose shape the CLI does not guarantee"* — while `modelUsage` is
 * typed and additionally carries `contextWindow` and `maxOutputTokens`. That
 * second half is why no window-size table exists anywhere in this repository:
 * the CLI hands the window back on every turn, and a table would be wrong
 * within a month of the next model release, silently, in the direction that
 * overfills.
 *
 * The differential assertion is the one that actually defends the rule. Every
 * fixture below populates `usage` with numbers that **disagree** with
 * `modelUsage`, so a parser that read the wrong field would not merely be
 * theoretically wrong — it would produce different output, and deleting `usage`
 * entirely would change the answer. A grep can be routed around; this cannot.
 *
 * Verifies: EPIC-09-S36 · KAR-09.7 AC2 · test plan #2, #3
 */
import { TokenUsageSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  parseShimLine,
  shimResultFailure,
  shimResultReport,
  shimResultUsage,
  turnCompletedReport,
} from '../src/index.ts';

const MODEL = 'claude-sonnet-4-5-20260514';

/**
 * The verified envelope, with `usage` deliberately populated with figures
 * nothing here should ever read. If any of these numbers reaches an assertion,
 * the parser read the trap.
 */
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'end_turn',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 999_001,
    output_tokens: 999_002,
    cache_creation_input_tokens: 999_003,
    cache_read_input_tokens: 999_004,
  },
  modelUsage: {
    [MODEL]: {
      inputTokens: 1_024,
      outputTokens: 37,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 12,
      webSearchRequests: 0,
      costUSD: 0.0123,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  },
  permission_denials: [],
  terminal_reason: 'complete',
  result: 'ok',
  session_id: 'sess-1',
  uuid: 'a5cf5c3e-0000-4000-8000-000000000001',
};

const line = (value: unknown): NonNullable<ReturnType<typeof parseShimLine>> => {
  const parsed = parseShimLine(JSON.stringify(value));
  if (parsed === null) throw new Error('expected a parsed line');
  return parsed;
};

suite('Tier 1 reads modelUsage and nothing else (AC2)', () => {
  it('takes every figure off modelUsage[model]', () => {
    const report = shimResultReport(line(RESULT));
    expect(report).toEqual({
      model: MODEL,
      usage: {
        inputTokens: 1_024,
        outputTokens: 37,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 12,
        source: 'vendor-reported',
      },
      costUsd: 0.0123,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
    expect(TokenUsageSchema.parse(report?.usage)).toEqual(report?.usage);
  });

  it('produces the identical report when usage is deleted from the envelope', () => {
    const { usage: _trap, ...withoutUsage } = RESULT;
    expect(shimResultReport(line(withoutUsage))).toEqual(shimResultReport(line(RESULT)));
  });

  it('is unmoved by a usage object of a shape the CLI never promised', () => {
    for (const trap of [null, 'nonsense', 42, [], { input_tokens: 'lots' }]) {
      expect(shimResultReport(line({ ...RESULT, usage: trap }))).toEqual(
        shimResultReport(line(RESULT)),
      );
    }
  });

  it('answers null when modelUsage is absent, rather than falling back to usage', () => {
    const { modelUsage: _gone, ...withoutModelUsage } = RESULT;
    expect(shimResultReport(line(withoutModelUsage))).toBeNull();
    // And the convenience wrapper degrades to zeros it labels, never to the
    // trap's figures.
    expect(shimResultUsage(line(withoutModelUsage))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      source: 'vendor-reported',
    });
  });

  it('omits the optional counters modelUsage did not report', () => {
    const sparse = line({
      ...RESULT,
      modelUsage: { [MODEL]: { inputTokens: 10, outputTokens: 2 } },
    });
    expect(shimResultReport(sparse)).toEqual({
      model: MODEL,
      usage: { inputTokens: 10, outputTokens: 2, source: 'vendor-reported' },
      costUsd: null,
      contextWindow: null,
      maxOutputTokens: null,
    });
  });

  it('sums a multi-model turn and names the model that did most of it', () => {
    const report = shimResultReport(
      line({
        ...RESULT,
        modelUsage: {
          'claude-haiku-4-5': { inputTokens: 100, outputTokens: 5, costUSD: 0.0001 },
          [MODEL]: {
            inputTokens: 1_024,
            outputTokens: 37,
            costUSD: 0.0123,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
        },
      }),
    );
    expect(report?.usage.inputTokens).toBe(1_124);
    expect(report?.usage.outputTokens).toBe(42);
    expect(report?.costUsd).toBeCloseTo(0.0124, 10);
    // The window belongs to the model the turn actually ran on, not to
    // whichever key JSON.parse happened to yield first.
    expect(report?.model).toBe(MODEL);
    expect(report?.contextWindow).toBe(200_000);
  });
});

suite('the jsonl dialect normalises to the same shape (test plan #3)', () => {
  const TURN = {
    type: 'turn.completed',
    usage: { input_tokens: 2_048, cached_input_tokens: 512, output_tokens: 96 },
  };

  it('reads input, cached-input and output into the same report', () => {
    expect(turnCompletedReport(line(TURN))).toEqual({
      model: null,
      usage: {
        inputTokens: 2_048,
        outputTokens: 96,
        cacheReadInputTokens: 512,
        source: 'vendor-reported',
      },
      costUsd: null,
      contextWindow: null,
      maxOutputTokens: null,
    });
  });

  it('says nothing about a window this dialect does not report', () => {
    const report = turnCompletedReport(line(TURN));
    expect(report?.contextWindow).toBeNull();
    expect(report?.maxOutputTokens).toBeNull();
  });

  it('ignores every other line type, including the result envelope', () => {
    expect(turnCompletedReport(line(RESULT))).toBeNull();
    expect(turnCompletedReport(line({ type: 'assistant' }))).toBeNull();
  });

  it('omits a cache counter the turn did not report', () => {
    const report = turnCompletedReport(
      line({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 1 } }),
    );
    expect(report?.usage).toEqual({ inputTokens: 7, outputTokens: 1, source: 'vendor-reported' });
  });
});

suite('the four documented result subtypes are typed failures (EPIC-09-S36)', () => {
  const cases: readonly [subtype: string, reason: string, failureClass: string][] = [
    ['error_during_execution', 'agent.nonzero-exit', 'transient'],
    ['error_max_turns', 'agent.max-turns', 'permanent'],
    ['error_max_budget_usd', 'budget.cost-exceeded', 'gate'],
    ['error_max_structured_output_retries', 'agent.schema-repair-exhausted', 'permanent'],
  ];

  for (const [subtype, reason, failureClass] of cases) {
    it(`${subtype} is ${reason} (${failureClass})`, () => {
      const failure = shimResultFailure(line({ ...RESULT, subtype, is_error: true, result: '' }));
      expect(failure).not.toBeNull();
      expect(failure?.deflowFailure).toMatchObject({ reason, class: failureClass });
    });
  }
});
