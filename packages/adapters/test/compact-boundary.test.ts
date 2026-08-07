/**
 * KAR-09.6 — the `compact_boundary` frame, read off the committed stream.
 *
 * The stream is `test/fixtures/streams/compact-boundary.stream-json.jsonl`,
 * whose provenance is written down beside it: the shape came from Claude Code
 * 2.1.220 (`fixtures/cli-shapes/`, and the boundary frame from the same
 * bundle's zod schemas), the bytes are synthetic. Parsing the committed file
 * rather than an object literal in this file is the point — a literal here
 * would be the parser's own author agreeing with themselves about what a
 * vendor emits.
 *
 * The two frames that must **not** produce a compaction are as load-bearing as
 * the one that must: `system` / `status` `compacting` drives a spinner
 * (EPIC-09-S31, second scenario), and an `assistant` line is not a system
 * frame at all.
 *
 * Verifies: EPIC-09-S31 · AC2, AC3 · test plan #1
 */
import { compactionTriggerOf, vendorCompaction } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { parseShimLine, shimCompactBoundary, shimResultReport } from '../src/index.ts';

const FIXTURE = fileURLToPath(
  new URL('../../../test/fixtures/streams/compact-boundary.stream-json.jsonl', import.meta.url),
);

const lines = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((text) => text.trim() !== '')
  .map((text) => parseShimLine(text))
  .filter((line) => line !== null);

suite('the committed stream is the one this story is about', () => {
  it('carries a compaction, a status frame and a result envelope', () => {
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.filter((line) => shimCompactBoundary(line) !== null)).toHaveLength(1);
    expect(lines.filter((line) => line.type === 'result')).toHaveLength(1);
  });
});

suite('AC2 — the boundary frame reports pre_tokens and nothing else', () => {
  const boundary = lines.map((line) => shimCompactBoundary(line)).find((it) => it !== null);

  it('reads the trigger and the pre-compaction total', () => {
    expect(boundary).toEqual({ trigger: 'auto', preTokens: 167_000 });
  });

  it('becomes a vendor.session compaction with an honest gap where after would be', () => {
    if (boundary === undefined) throw new Error('the fixture has no compact_boundary frame');

    expect(vendorCompaction(boundary)).toMatchObject({
      scope: 'vendor.session',
      fidelity: 'partial',
      trigger: compactionTriggerOf('auto'),
      before: 167_000,
      after: null,
      droppedSegments: [],
      demotedToHandles: [],
      originalHandle: null,
    });
  });
});

suite('the frames that are not a compaction', () => {
  it('reads no boundary out of the live status frame — that is a spinner', () => {
    const status = lines.find((line) => line.raw.subtype === 'status');

    expect(status, 'the fixture must contain the status frame').toBeDefined();
    if (status === undefined) throw new Error('unreachable');
    expect(shimCompactBoundary(status)).toBeNull();
  });

  it('reads no boundary out of an assistant line', () => {
    const assistant = lines.find((line) => line.type === 'assistant');

    if (assistant === undefined) throw new Error('the fixture has no assistant line');
    expect(shimCompactBoundary(assistant)).toBeNull();
  });

  it('refuses a boundary frame whose metadata is missing pre_tokens', () => {
    const malformed = parseShimLine(
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: {} }),
    );

    if (malformed === null) throw new Error('unreachable');
    // Null rather than a zero: "the vendor reported nothing" and "the vendor
    // reported no tokens" are different claims, and a 0 here would draw a bar.
    expect(shimCompactBoundary(malformed)).toBeNull();
  });
});

suite('AC4 — the next envelope supplies the approximation, never the fidelity', () => {
  it("reports the following turn's input tokens off modelUsage", () => {
    const result = lines.find((line) => line.type === 'result');

    if (result === undefined) throw new Error('the fixture has no result envelope');
    const report = shimResultReport(result);
    expect(report?.usage.inputTokens).toBe(84_210);
    expect(report?.contextWindow).toBe(200_000);
    expect(report?.maxOutputTokens).toBe(32_000);
  });
});
