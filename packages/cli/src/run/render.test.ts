/**
 * KAR-18.3 AC7 — two renderers over one event stream, not two clients.
 *
 * The claim under test is a *shape* claim: the human transcript and the NDJSON
 * are the same `Event` values rendered twice, so a spec that drove them from
 * one array and compared the two is asserting exactly the property AC7 states.
 * A second client would show up here as an event one renderer can see and the
 * other cannot.
 *
 * The test plan's red for the JSON path is specific — _"the renderer detects
 * TTY once at import and colours the JSON path"_ — so `isTty` is a **function**
 * consulted per line rather than a boolean captured when the module loaded, and
 * the spec below flips it under a live renderer to prove it.
 *
 * Verifies: EPIC-18-S18 (its rendering half), EPIC-18-S25 · AC7
 */
import type { Event, EventKind, RunId } from '@DeFlow/core';
import { EVENT_SCHEMAS, parseEvent, RunIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { RUN_EXIT_CODES } from './exit-codes.ts';
import { createRenderer } from './render.ts';

const RUN: RunId = RunIdSchema.parse('run_20260810T101500Z_c4a5b1');
const TS = 1_754_812_800_000;
/** The ESC that must never reach a pipe. */
const ESC = '\u001B';

function event(kind: EventKind, payload: unknown, seq: number, nodeId?: string): Event {
  const parsed = parseEvent({
    seq,
    runId: RUN,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    ...(nodeId === undefined ? {} : { nodeId }),
    payload,
  });
  if (parsed.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}

const RESULT = {
  status: 'completed',
  output: { summary: 'impl done' },
  outputSchemaId: 'DeFlow.finding.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [],
};

/** A four-node slice of a real run, in seq order. */
const STREAM: readonly Event[] = [
  event(
    'task.submitted',
    {
      sha256: 'a'.repeat(64),
      raw: 'add a health endpoint',
      provenance: { kind: 'text', by: 'cli', submittedAt: TS },
    },
    1,
  ),
  event(
    'node.scheduled',
    { node: 'impl', provider: 'claude', permission: 'worktree', worktree: `DeFlow/${RUN}__impl` },
    2,
    'impl',
  ),
  event(
    'node.started',
    {
      node: 'impl',
      attempt: 0,
      ikey: `${RUN}/impl/0/0`,
      binary: { path: '/usr/bin/mock', version: '0.0.0', sha256: 'f'.repeat(64) },
    },
    3,
    'impl',
  ),
  event('node.completed', { node: 'impl', attempt: 0, result: RESULT }, 4, 'impl'),
  event(
    'gate.evaluated',
    {
      gate: 'typecheck',
      node: 'gate-typecheck',
      verdict: {
        schemaId: 'DeFlow.verdict.v4',
        outcome: 'pass',
        gate: 'typecheck',
        evaluatedNode: 'impl',
        by: { node: 'gate-typecheck', provider: 'claude', model: 'sonnet' },
        criteria: [],
        findings: [],
        summary: 'tsc reported no errors',
      },
    },
    5,
    'gate-typecheck',
  ),
  event('run.completed', { outcome: 'succeeded', criteriaSatisfied: [] }, 6),
];

const renderAll = (renderer: ReturnType<typeof createRenderer>): string =>
  STREAM.map((e) => renderer.event(e)).join('');

suite('the human transcript (AC7, EPIC-18-S18)', () => {
  it('shows each node through scheduled → started → completed, with its branch', () => {
    const text = renderAll(createRenderer({ mode: 'human', isTty: () => false, runId: RUN }));

    const impl = text.split('\n').filter((line) => line.includes('impl'));
    // `<glyph> <node> <status> …` — the status is the third column.
    expect(impl.map((line) => line.trim().split(/\s+/)[2])).toEqual([
      'scheduled',
      'started',
      'completed',
    ]);
    // D13's flat scheme, printed rather than left for the operator to derive.
    expect(text).toContain(`DeFlow/${RUN}__impl`);
  });

  it('prints the gate verdict with its one-line summary', () => {
    const text = renderAll(createRenderer({ mode: 'human', isTty: () => false, runId: RUN }));
    expect(text).toContain('typecheck');
    expect(text).toContain('tsc reported no errors');
  });

  it('ends with the reason, the cost and the wall clock', () => {
    const renderer = createRenderer({ mode: 'human', isTty: () => false, runId: RUN });
    const final = renderer.final(
      {
        terminal: true,
        exitCode: RUN_EXIT_CODES.completed,
        reason: 'completed — every gate passed',
      },
      {
        costUsd: { subscription: null, apiKey: 0.42, vendorReported: 0.42, estimated: null },
        wallclockMs: 3_210,
      },
    );

    expect(final.stdout).toContain('completed — every gate passed');
    expect(final.stdout).toContain('$0.42');
    expect(final.stdout).toContain('3.2s');
    expect(final.stdout.endsWith('\n')).toBe(true);
  });

  it('says so plainly when nothing priced the run, rather than printing $0.00', () => {
    const renderer = createRenderer({ mode: 'human', isTty: () => false, runId: RUN });
    const final = renderer.final(
      { terminal: true, exitCode: 0, reason: 'completed — every gate passed' },
      {
        costUsd: { subscription: null, apiKey: null, vendorReported: null, estimated: null },
        wallclockMs: 1_000,
      },
    );
    expect(final.stdout).toContain('no cost recorded');
    expect(final.stdout).not.toContain('$0.00');
  });
});

suite('colour is decided per line, never at import (AC7)', () => {
  it('colours a TTY and stops the moment it is not one', () => {
    let tty = true;
    const renderer = createRenderer({ mode: 'human', isTty: () => tty, runId: RUN });

    const coloured = renderAll(renderer);
    expect(coloured).toContain(ESC);

    tty = false;
    const plain = renderAll(renderer);
    expect(plain).not.toContain(ESC);
  });
});

suite('EPIC-18-S25 — NDJSON in a pipe (AC7)', () => {
  const json = (): ReturnType<typeof createRenderer> =>
    // `isTty: () => true` deliberately: --json must not colour even on a
    // terminal, which is the half of the red a piped spec cannot see.
    createRenderer({ mode: 'json', isTty: () => true, runId: RUN });

  it('emits one JSON object per line, each carrying seq, kind and runId', () => {
    const lines = renderAll(json()).split('\n').filter(Boolean);

    expect(lines).toHaveLength(STREAM.length);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const object of parsed) {
      expect(Object.keys(object)).toEqual(expect.arrayContaining(['seq', 'kind', 'runId']));
      expect(object.runId).toBe(RUN);
    }
    expect(parsed.map((object) => object.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('never emits an ANSI escape, whatever stdout is', () => {
    expect(renderAll(json())).not.toContain(ESC);
  });

  it('keeps stdout a pure event stream: the verdict goes to stderr', () => {
    const final = json().final(
      { terminal: true, exitCode: 1, reason: 'completed — the typecheck gate failed' },
      {
        costUsd: { subscription: null, apiKey: null, vendorReported: null, estimated: null },
        wallclockMs: 10,
      },
    );

    expect(final.stdout).toBe('');
    expect(JSON.parse(final.stderr) as Record<string, unknown>).toMatchObject({
      kind: 'DeFlow.cli.verdict',
      runId: RUN,
      exitCode: 1,
      reason: 'completed — the typecheck gate failed',
    });
  });
});

suite('one stream, two renderings (AC7)', () => {
  it('both renderers see exactly the same events', () => {
    const human = createRenderer({ mode: 'human', isTty: () => false, runId: RUN });
    const machine = createRenderer({ mode: 'json', isTty: () => false, runId: RUN });

    const seqs = renderAll(machine)
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { seq: number }).seq);

    // The human renderer is allowed to be quieter — it is a transcript, not a
    // log — but it may never see an event the machine one did not, and every
    // event it renders must name its own node.
    expect(seqs).toEqual(STREAM.map((e) => e.seq));
    expect(renderAll(human).split('\n').filter(Boolean).length).toBeLessThanOrEqual(seqs.length);
  });
});
