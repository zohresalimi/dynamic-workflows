/**
 * KAR-19.12 AC1, AC2, AC3 — the block a waiting run prints, in both renderings.
 *
 * The by-hand run of 2026-08-14 did render the `human.requested` line: several
 * hundred words of rendered spec, and not one sentence saying *this has stopped
 * and is waiting for you* or naming the four options it was offering. So the
 * assertions below are about the sentence, the option ids and the two ways to
 * answer — a spec that only checked that something was printed would have been
 * green on the afternoon the operator killed the process.
 *
 * Verifies: EPIC-19-S79, EPIC-19-S81 · KAR-19.12 AC1, AC2, AC3 · test plan #2
 */
import type { Event, PendingGate, RunId } from '@DeFlow/core';
import {
  EVENT_SCHEMAS,
  parseEvent,
  RunIdSchema,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { createRenderer } from './render.ts';

const RUN: RunId = RunIdSchema.parse('run_20260814T013434Z_c984dd');
const BASE_URL = 'http://127.0.0.1:7777';
/** The ESC that must never reach a pipe. */
const ESC = '\u001B';

const SPEC_GATE: PendingGate = {
  node: SPEC_GATE_NODE,
  prompt: 'Goal\nAdd a hello function',
  options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
  requestedSeq: 7,
  specApproval: true,
  reason: null,
};

const renderer = (mode: 'human' | 'json', isTty = false) =>
  createRenderer({ mode, isTty: () => isTty, runId: RUN, baseUrl: BASE_URL });

/** The human block, with the wrapping normalised: where a long command breaks
 * is KAR-18.9 AC4's decision and not this story's. */
const humanBlock = (): string => renderer('human').gate(SPEC_GATE).stdout.replaceAll(/\s+/g, ' ');

suite('AC1 — the block says what is waiting and what it offers', () => {
  it('names the gate, the wait and every option by id and label', () => {
    const block = humanBlock();

    expect(block).toContain(SPEC_GATE_NODE);
    expect(block.toLowerCase()).toContain('waiting for you');
    for (const option of SPEC_APPROVAL_OPTIONS) {
      expect(block).toContain(option.id);
      expect(block).toContain(option.label);
    }
  });

  it('says nothing on stderr, where a person is not looking', () => {
    expect(renderer('human').gate(SPEC_GATE).stderr).toBe('');
  });
});

suite('AC2 — it says how to answer, both ways', () => {
  it('carries the exact command and the run URL', () => {
    const block = humanBlock();

    expect(block).toContain(
      `deflow answer ${RUN} --gate ${SPEC_GATE_NODE} --option ${SPEC_APPROVAL_OPTIONS[0].id}`,
    );
    expect(block).toContain(`${BASE_URL}/runs/${RUN}`);
  });
});

suite('AC3 — --json stays one object per line, and nothing colours a pipe', () => {
  it('emits exactly one NDJSON object carrying the same facts, on stderr', () => {
    const announcement = renderer('json').gate(SPEC_GATE);

    // stdout under `--json` is a `seq`-ordered stream of events and nothing
    // else; an announcement has no `seq` of its own, so it goes where the
    // verdict goes.
    expect(announcement.stdout).toBe('');
    const block = announcement.stderr;

    expect(block.endsWith('\n')).toBe(true);
    const lines = block.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const object = JSON.parse(lines[0] as string) as {
      kind: string;
      runId: string;
      node: string;
      options: readonly { id: string; label: string }[];
      answer: string;
      url: string;
    };
    expect(object.kind).toBe('DeFlow.cli.gate');
    expect(object.runId).toBe(RUN);
    expect(object.node).toBe(SPEC_GATE_NODE);
    expect(object.options.map((option) => option.id)).toEqual(
      SPEC_APPROVAL_OPTIONS.map((option) => option.id),
    );
    expect(object.answer).toContain(`--gate ${SPEC_GATE_NODE}`);
    expect(object.url).toBe(`${BASE_URL}/runs/${RUN}`);
  });

  it('writes no escape byte on either stream, whatever the TTY says', () => {
    const json = renderer('json', true).gate(SPEC_GATE);
    expect(json.stdout + json.stderr).not.toContain(ESC);
    const human = renderer('human', false).gate(SPEC_GATE);
    expect(human.stdout + human.stderr).not.toContain(ESC);
  });
});

suite('AC7 — an answer from anywhere is a line of its own', () => {
  it('names the node, the option and who chose it', () => {
    const line = renderer('human').event(
      answered({ node: SPEC_GATE_NODE, optionId: 'approve', by: 'operator' }),
    );

    expect(line).toContain(SPEC_GATE_NODE);
    expect(line).toContain('approve');
    expect(line).toContain('operator');
  });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function answered(payload: { node: string; optionId: string; by: string }): Event {
  const parsed = parseEvent({
    seq: 8,
    runId: RUN,
    ts: 1_786_670_000_000,
    kind: 'human.responded',
    v: EVENT_SCHEMAS['human.responded'].v,
    epoch: 1,
    nodeId: payload.node,
    payload: { ...payload, at: new Date(1_786_670_000_000).toISOString() },
  });
  if (parsed.status !== 'ok') {
    throw new Error(`fixture is not a valid event: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}
