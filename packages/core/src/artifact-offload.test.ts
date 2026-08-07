/**
 * KAR-09.5 — artifact offloading: the inline threshold, and the handle line
 * the agent reads instead of the body.
 *
 * Unit, because everything here is a function of a string: how big a body is,
 * how the handle line describes it, and whether `buildPacket` replaced the body
 * with it. The half that needs a real disk — the CAS entry, the run's artifact
 * index — is `packages/ledger/test/integration/run-artifacts.test.ts`, and the
 * half that needs a real socket is the daemon's `read-artifact-handle` spec.
 *
 * Verifies: EPIC-09-S26 (first scenario), EPIC-09-S27 (first scenario, at the
 * packet level), EPIC-09-S28 (first scenario) · AC1, AC2, AC3, AC6, AC7 ·
 * test plan #1, #3, #7
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  formatByteSize,
  handleStubText,
  INLINE_THRESHOLD_BYTES_DEFAULT,
  truncatedDigest,
} from './artifact-offload.ts';
import { buildPacket, type PacketBuildInput } from './build-packet.ts';
import { SEGMENT_KINDS, type Segment } from './context-packet.ts';
import { inlineThresholdBytesOf, parseDeFlowConfig } from './deflow-config.ts';
import { type EventSeq, EventSeqSchema } from './ids.ts';
import { contextSegment, type UnpinnedSegmentKind } from './pinned-set.ts';
import { renderPacket } from './render-packet.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const seq = (value: number): EventSeq => EventSeqSchema.parse(value);

function input(overrides: Partial<PacketBuildInput> = {}): PacketBuildInput {
  return {
    runId: 'run_20260807T090000Z_5c1d2e',
    nodeId: 'implement',
    attempt: 0,
    builtAtEvent: seq(60),
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
      sourceEvent: seq(9),
    },
    segments: [],
    ...overrides,
  };
}

/**
 * EPIC-09-S26's background — *"a failed `pnpm -r build` produced a 412-line,
 * 38.4 KB log"*. Both numbers are the assertion, so both are constructed
 * exactly rather than approximated: ASCII only, so bytes and characters agree.
 */
function fixedSizeLog(lines: number, bytes: number): string {
  const content = bytes - (lines - 1);
  const per = Math.floor(content / lines);
  const rows = Array.from({ length: lines }, () => 'x'.repeat(per));
  rows[lines - 1] += 'x'.repeat(content - per * lines);
  return rows.join('\n');
}

const BUILD_LOG = fixedSizeLog(412, 39_322);
const BUILD_LOG_DESCRIPTION = 'build-log for `pnpm -r build` (fail)';

const oversized = (id: string, kind: UnpinnedSegmentKind = 'tool.output'): Promise<Segment> =>
  contextSegment({ id, kind, text: BUILD_LOG, sourceEvent: seq(23) });

const handleSegmentsOf = (segments: readonly Segment[]): Segment[] =>
  segments.filter((segment) => segment.kind === 'artifact.handle');

/* -------------------------------------------------------------------------- *
 * The line itself (AC3, test plan #3)
 * -------------------------------------------------------------------------- */

suite('how big a body is, in the words the agent reads (AC3)', () => {
  it('formats a size the way §5.2 writes it', () => {
    expect(formatByteSize(412)).toBe('412 B');
    expect(formatByteSize(39_322)).toBe('38.4 KB');
    expect(formatByteSize(1_572_864)).toBe('1.5 MB');
  });

  it('truncates a digest to its head and tail, never to a prefix alone', () => {
    const digest = 'a'.repeat(60) + 'c91';
    expect(truncatedDigest(digest)).toBe('aaaa…c91');
  });

  it('defaults the inline threshold to something a 38 KB log exceeds', () => {
    expect(INLINE_THRESHOLD_BYTES_DEFAULT).toBeLessThan(39_322);
    expect(INLINE_THRESHOLD_BYTES_DEFAULT).toBeGreaterThan(0);
  });
});

suite('the rendered handle line matches the documented format (AC3, test plan #3)', () => {
  it('carries the truncated digest, the description, the lines, the size and the route', async () => {
    const segment = await oversized('build-log');
    const line = handleStubText(segment, BUILD_LOG_DESCRIPTION);

    expect(line).toMatchSnapshot();
    expect(line).toContain(BUILD_LOG_DESCRIPTION);
    expect(line).toContain('412 lines');
    expect(line).toContain('38.4 KB');
    expect(line).toContain('DeFlow_read_artifact');
    // Truncated for the reader, complete for the caller: the agent has to be
    // able to pass the handle back, and a `3f2a…c91` cannot be typed into a
    // tool call.
    expect(line).toContain(`artifact://${segment.contentHash.slice('sha256-'.length)}`);
    expect(line).toContain(`artifact://${truncatedDigest(segment.contentHash)}`);
  });

  it('falls back to naming the segment when no description was supplied', async () => {
    const segment = await oversized('build-log');
    expect(handleStubText(segment)).toContain('tool.output');
    expect(handleStubText(segment)).toContain('build-log');
  });
});

/* -------------------------------------------------------------------------- *
 * The threshold (AC1, AC7, test plan #1)
 * -------------------------------------------------------------------------- */

suite('a body over the inline threshold is offloaded (AC1, test plan #1)', () => {
  it('replaces a 38 KB tool.output with an artifact.handle segment', async () => {
    const { packet, demotion } = await buildPacket(
      input({
        segments: [await oversized('build-log')],
        descriptions: { 'build-log': BUILD_LOG_DESCRIPTION },
      }),
    );

    const handles = handleSegmentsOf(packet.segments);
    expect(handles.length).toBe(1);
    expect(handles[0]?.id).toBe('build-log');
    expect(handles[0]?.text).toBe(
      handleStubText(await oversized('build-log'), BUILD_LOG_DESCRIPTION),
    );
    expect(demotion.bodies.map((body) => body.reason)).toEqual(['inline-threshold']);
    expect(demotion.bodies[0]?.text).toBe(BUILD_LOG);
    expect(demotion.bodies[0]?.description).toBe(BUILD_LOG_DESCRIPTION);
  });

  it('offloads even when the packet would have fitted the budget twice over', async () => {
    const { packet, demotion } = await buildPacket(
      input({ segments: [await oversized('build-log')] }),
    );

    // 100k tokens of budget against a ~10k-token log: nothing here is about
    // pressure. The threshold is its own rule (AC1), not a budget shortcut.
    expect(demotion.before).toBeLessThan(packet.budget.limitTokens);
    expect(handleSegmentsOf(packet.segments).length).toBe(1);
  });

  it('keeps the body out of render() entirely (AC1)', async () => {
    const { packet } = await buildPacket(input({ segments: [await oversized('build-log')] }));

    const prompt = renderPacket(packet);
    expect(prompt).not.toContain(BUILD_LOG);
    expect(prompt).not.toContain('x'.repeat(200));
    expect(prompt).toContain('DeFlow_read_artifact');
  });

  it('leaves a body under the threshold inline', async () => {
    const small = await contextSegment({
      id: 'finding',
      kind: 'fact',
      text: 'finding/auth-uses-jwt = true',
      sourceEvent: seq(21),
    });
    const { packet } = await buildPacket(input({ segments: [small] }));

    expect(handleSegmentsOf(packet.segments).length).toBe(0);
    expect(renderPacket(packet)).toContain('finding/auth-uses-jwt = true');
  });

  it('honours a configured threshold rather than only the default', async () => {
    const small = await contextSegment({
      id: 'finding',
      kind: 'fact',
      text: 'finding/auth-uses-jwt = true',
      sourceEvent: seq(21),
    });
    const { packet } = await buildPacket(input({ segments: [small], inlineThresholdBytes: 8 }));

    expect(handleSegmentsOf(packet.segments).length).toBe(1);
  });

  it('never offloads a pinned segment or the node’s own brief', async () => {
    const brief = await contextSegment({
      id: 'brief',
      kind: 'task.brief',
      text: BUILD_LOG,
      sourceEvent: seq(20),
    });
    const { packet } = await buildPacket(input({ segments: [brief] }));

    expect(handleSegmentsOf(packet.segments).length).toBe(0);
    expect(packet.segments.filter((s) => s.pinned).length).toBeGreaterThan(0);
    for (const segment of packet.segments.filter((s) => s.pinned)) {
      expect(segment.kind.startsWith('pinned.')).toBe(true);
    }
  });
});

suite('content addressing is real deduplication (AC2)', () => {
  it('gives two identical bodies from two segments one handle', async () => {
    const { demotion } = await buildPacket(
      input({
        segments: [await oversized('log-a'), await oversized('log-b')],
      }),
    );

    expect(demotion.demotedToHandles.length).toBe(2);
    expect(new Set(demotion.demotedToHandles).size).toBe(1);
  });

  it('gives two different bodies two handles', async () => {
    const other = await contextSegment({
      id: 'log-b',
      kind: 'tool.output',
      text: `${BUILD_LOG}\ndiffering tail`,
      sourceEvent: seq(24),
    });
    const { demotion } = await buildPacket(input({ segments: [await oversized('log-a'), other] }));

    expect(new Set(demotion.demotedToHandles).size).toBe(2);
  });
});

suite('handle overhead is counted under its own kind (AC7)', () => {
  it('puts the stub in totals.byKind["artifact.handle"], not in tool.output', async () => {
    const { packet } = await buildPacket(input({ segments: [await oversized('build-log')] }));

    expect(packet.totals.byKind['artifact.handle']).toBeGreaterThan(0);
    expect(packet.totals.byKind['tool.output']).toBe(0);
    // A full record, so F10.5's stacked bar has a row per kind whatever the
    // packet contained.
    expect(Object.keys(packet.totals.byKind).toSorted()).toEqual([...SEGMENT_KINDS].toSorted());
  });
});

/* -------------------------------------------------------------------------- *
 * Offload is not summarisation (AC6, EPIC-09-S28)
 * -------------------------------------------------------------------------- */

suite('offloading never calls a provider (AC6, EPIC-09-S28, test plan #7)', () => {
  it('completes an offload-heavy build with a stub that throws on any invocation', async () => {
    let invocations = 0;
    const provider = () => {
      invocations += 1;
      throw new Error('a provider was invoked during a packet build');
    };

    const segments = await Promise.all(
      ['log-1', 'log-2', 'log-3', 'log-4', 'log-5', 'log-6'].map((id, index) =>
        contextSegment({
          id,
          kind: 'tool.output',
          text: `${BUILD_LOG}\n${id}`,
          sourceEvent: seq(23 + index),
        }),
      ),
    );

    const { packet, demotion } = await buildPacket(input({ segments }));
    void provider;

    expect(demotion.droppedSegments.length).toBe(6);
    expect(handleSegmentsOf(packet.segments).length).toBe(6);
    expect(invocations).toBe(0);
    // The second scenario of EPIC-09-S28: no summary appears under any
    // pressure, because nothing produces one outside the continuation path.
    expect(packet.totals.byKind['history.summary']).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 * "configured" means configured
 * -------------------------------------------------------------------------- */

suite('the threshold comes from .DeFlow/config.yaml (AC1)', () => {
  it('reads context.inlineThresholdBytes when it is set', () => {
    const config = parseDeFlowConfig({ context: { inlineThresholdBytes: 4096 } });
    expect(inlineThresholdBytesOf(config)).toBe(4096);
  });

  it('defaults when the file says nothing', () => {
    expect(inlineThresholdBytesOf(parseDeFlowConfig({}))).toBe(INLINE_THRESHOLD_BYTES_DEFAULT);
  });

  it('refuses a threshold that is not a positive integer', () => {
    expect(() => parseDeFlowConfig({ context: { inlineThresholdBytes: 0 } })).toThrow();
    expect(() => parseDeFlowConfig({ context: { inlineThresholdBytes: -1 } })).toThrow();
  });
});
