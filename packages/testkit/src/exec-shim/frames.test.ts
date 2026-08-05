/**
 * KAR-04.6 — the Claude Code `stream-json` envelope, checked against the shape
 * that was read off the real binary rather than against itself.
 *
 * `fixtures/cli-shapes/claude-code@2.1.220.json` is the recorded shape
 * (docs/07-provider-adapter-layer.md §8.1, verified by execution 2026-08-02).
 * Comparing the fake's envelope to it is the only thing standing between "the
 * fake emits a result line" and "the fake emits a result line a real Claude
 * Code could have emitted" — and every parser test downstream is worth exactly
 * as much as that distinction.
 *
 * Verifies: EPIC-04-S17 (envelope half), EPIC-04-S20 (rate limit, denials) ·
 * AC3, AC5 · test plan row 3
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { repoRoot } from '../snapshot.ts';
import { claudeStreamJson, RESULT_SUBTYPES, uuidsFromSeed } from './frames.ts';

interface RecordedShape {
  readonly streamJson: {
    readonly everyLineCarries: readonly string[];
    readonly resultEnvelopeKeys: readonly string[];
    readonly rateLimitEventKeys: readonly string[];
    readonly rateLimitInfoKeys: readonly string[];
  };
}

const recorded = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures/cli-shapes/claude-code@2.1.220.json'), 'utf8'),
) as RecordedShape;

const SESSION = '8f1b0a3c-2d4e-4f60-9a71-5c3e2b8d0f11';
const NOW_MS = 1_785_000_000_000;

const writer = (): ReturnType<typeof claudeStreamJson> =>
  claudeStreamJson({ sessionId: SESSION, nextUuid: uuidsFromSeed(42), nowMs: NOW_MS });

const keysOf = (line: Record<string, unknown>): string[] => Object.keys(line).sort();

suite('every line carries the session and its own id (AC3)', () => {
  it('stamps session_id and uuid on all five line types', () => {
    const frames = writer();
    const lines = [
      frames.systemInit(),
      frames.activeGoal('ship KAR-04.6'),
      frames.assistant('ok'),
      frames.rateLimit('allowed_warning', 900),
      frames.result({
        subtype: 'success',
        isError: false,
        stopReason: 'end_turn',
        text: 'ok',
        totalCostUsd: 0.0123,
        permissionDenials: [],
      }),
    ];

    for (const line of lines) {
      for (const key of recorded.streamJson.everyLineCarries) {
        expect(line, `${String(line.type)} carries ${key}`).toHaveProperty(key);
      }
      expect(line.session_id).toBe(SESSION);
    }
  });

  it('gives every line a different uuid — a constant one would let a broken dedup pass', () => {
    const frames = writer();
    const uuids = [
      frames.systemInit(),
      frames.assistant('one'),
      frames.assistant('two'),
      frames.assistant('three'),
      frames.result({
        subtype: 'success',
        isError: false,
        stopReason: 'end_turn',
        text: 'ok',
        totalCostUsd: 0,
        permissionDenials: [],
      }),
    ].map((line) => line.uuid as string);

    expect(new Set(uuids).size).toBe(uuids.length);
  });
});

suite('the uuids are seeded, so a run is reproducible', () => {
  it('produces the same sequence for the same seed', () => {
    const first = Array.from({ length: 4 }, uuidsFromSeed(7));
    const second = Array.from({ length: 4 }, uuidsFromSeed(7));
    expect(second).toEqual(first);
  });

  it('produces a different sequence for a different seed', () => {
    expect(Array.from({ length: 4 }, uuidsFromSeed(8))).not.toEqual(
      Array.from({ length: 4 }, uuidsFromSeed(7)),
    );
  });

  it('is shaped like a v4 uuid, because that is what the field holds', () => {
    expect(uuidsFromSeed(1)()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

suite('the result envelope is the recorded one (test plan row 3)', () => {
  it('carries exactly the recorded key set — no invented fields, none missing', () => {
    const line = writer().result({
      subtype: 'success',
      isError: false,
      stopReason: 'end_turn',
      text: 'ok',
      totalCostUsd: 0.0123,
      permissionDenials: [],
    });

    expect(keysOf(line)).toEqual([...recorded.streamJson.resultEnvelopeKeys].sort());
    expect(line.type).toBe('result');
    expect(line.subtype).toBe('success');
    expect(line.is_error).toBe(false);
    expect(line.total_cost_usd).toBe(0.0123);
    expect(line.result).toBe('ok');
  });

  it('offers the failure subtypes the taxonomy needs a source for', () => {
    expect([...RESULT_SUBTYPES]).toContain('error_max_structured_output_retries');
    expect([...RESULT_SUBTYPES]).toContain('error_during_execution');
  });

  it('marks a schema-repair exhaustion as an error, so is_error is not decoration', () => {
    const line = writer().result({
      subtype: 'error_max_structured_output_retries',
      isError: true,
      stopReason: 'refusal',
      text: '',
      totalCostUsd: 0.5,
      permissionDenials: [],
    });

    expect(line.subtype).toBe('error_max_structured_output_retries');
    expect(line.is_error).toBe(true);
  });

  it('names the denied tool in permission_denials', () => {
    const line = writer().result({
      subtype: 'success',
      isError: false,
      stopReason: 'end_turn',
      text: 'refused',
      totalCostUsd: 0,
      permissionDenials: [
        { toolName: 'Bash', toolUseId: 'toolu_01', toolInput: { command: 'rm' } },
      ],
    });

    expect(line.permission_denials).toEqual([
      { tool_name: 'Bash', tool_use_id: 'toolu_01', tool_input: { command: 'rm' } },
    ]);
  });

  it('reports usage and per-model usage as objects a cost reader can walk', () => {
    const line = writer().result({
      subtype: 'success',
      isError: false,
      stopReason: 'end_turn',
      text: 'ok',
      totalCostUsd: 0.25,
      permissionDenials: [],
    });

    expect(line.usage).toMatchObject({ input_tokens: expect.any(Number) });
    expect(Object.keys(line.modelUsage as object).length).toBeGreaterThan(0);
  });
});

suite('rate_limit_event carries a resetsAt a scheduler can use (AC5)', () => {
  it('is the recorded shape, with resetsAt an epoch second offset from now', () => {
    const line = writer().rateLimit('allowed_warning', 900);

    expect(keysOf(line)).toEqual([...recorded.streamJson.rateLimitEventKeys].sort());
    expect(line.type).toBe('rate_limit_event');

    const info = line.rate_limit_info as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual([...recorded.streamJson.rateLimitInfoKeys].sort());
    expect(info.status).toBe('allowed_warning');
    expect(info.resetsAt).toBe(Math.floor(NOW_MS / 1000) + 900);
  });
});
