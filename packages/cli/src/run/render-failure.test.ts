/**
 * KAR-19.9 AC4 / EPIC-19-S62 — the attached view says which attempt failed and
 * why, while the run is still retrying.
 *
 * The operator's actual experience on 2026-08-13 was a command that printed
 * **nothing** for seven minutes and then had to be killed, which is worse than a
 * crash — a crash at least ends. Every failing attempt now reaches the terminal
 * as one line, and the line has to carry three things or it is not worth
 * printing: which node failed, which attempt that was *out of the ceiling*, and
 * the typed reason from the closed taxonomy.
 *
 * The ceiling is on the event rather than known to this renderer, and that is
 * the point of asserting it here: a CLI that spelled `3` would be a second copy
 * of the node's own `RetryPolicy`, living one process away from the daemon that
 * actually applies it, and the two would disagree the first time somebody set
 * `maxAttempts: 5` in a plan. A failure recorded by something that did not know
 * the ceiling prints the attempt alone rather than inventing one.
 *
 * Verifies: EPIC-19-S62 · KAR-19.9 AC4
 */
import type { Event, EventKind, RunId } from '@DeFlow/core';
import { EVENT_SCHEMAS, parseEvent, RunIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { createRenderer } from './render.ts';

const RUN: RunId = RunIdSchema.parse('run_20260813T110608Z_379fc8');
const TS = 1_755_080_000_000;
/** The ESC that must never reach a pipe. */
const ESC = '';

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

/** The failure the reported run produced, on its second of three attempts. */
const failed = (attempt: number, maxAttempts?: number): Event =>
  event(
    'node.failed',
    {
      node: 'framing',
      attempt,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      failure: {
        reason: 'agent.nonzero-exit',
        class: 'transient',
        message: 'claude exited 1: Invalid session ID',
        detail: { exitCode: 1 },
        evidence: [],
        occurredAtEvent: 3,
        attempt,
      },
    },
    10 + attempt,
    'framing',
  );

const human = () => createRenderer({ mode: 'human', isTty: () => false, runId: RUN });

const json = () => createRenderer({ mode: 'json', isTty: () => true, runId: RUN });

suite('EPIC-19-S62 — each failed attempt is one line naming node, attempt and reason', () => {
  it('names the node, the attempt out of the ceiling, and the typed reason', () => {
    const line = human().event(failed(1, 3));

    expect(line).toContain('framing');
    expect(line).toContain('attempt 2 of 3');
    expect(line).toContain('agent.nonzero-exit');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('prints the attempt alone when the appender did not know the ceiling', () => {
    const line = human().event(failed(0));

    expect(line).toContain('attempt 1');
    expect(line).not.toContain(' of ');
    expect(line).toContain('agent.nonzero-exit');
  });

  it('is one line per attempt, in order, rather than a summary at the end', () => {
    const renderer = human();
    const lines = [failed(0, 3), failed(1, 3), failed(2, 3)].map((one) => renderer.event(one));

    expect(lines.map((line) => line.trim().length > 0)).toEqual([true, true, true]);
    expect(lines[0]).toContain('attempt 1 of 3');
    expect(lines[1]).toContain('attempt 2 of 3');
    expect(lines[2]).toContain('attempt 3 of 3');
  });

  it('--json emits the same content as NDJSON with no ANSI', () => {
    const rendered = json().event(failed(1, 3));

    expect(rendered).not.toContain(ESC);
    expect(rendered.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(rendered) as {
      kind: string;
      payload: { node: string; attempt: number; maxAttempts?: number; failure: { reason: string } };
    };
    expect(parsed.kind).toBe('node.failed');
    expect(parsed.payload.node).toBe('framing');
    expect(parsed.payload.attempt).toBe(1);
    expect(parsed.payload.maxAttempts).toBe(3);
    expect(parsed.payload.failure.reason).toBe('agent.nonzero-exit');
  });
});

/**
 * KAR-19.8 AC5 — when the vendor refused one of DeFlow's *own* arguments, the
 * line says which one.
 *
 * `agent.nonzero-exit` alone sends the operator to a stack trace to learn that
 * the argument DeFlow chose was the problem — which is the whole of the
 * 2026-08-13 defect from the outside. The flag and the value are on the
 * failure's `detail`, so the line can name them without a second lookup.
 */
suite('EPIC-19-S55 — a refused argument is named on the terminal line', () => {
  const refused = event(
    'node.failed',
    {
      node: 'framing',
      attempt: 0,
      failure: {
        reason: 'agent.nonzero-exit',
        class: 'permanent',
        message: 'claude refused the argument --session-id that DeFlow passed',
        detail: {
          provider: 'claude',
          flag: '--session-id',
          value: 'run_20260813T110608Z_379fc8-framing',
          stderr: 'Error: Invalid session ID. Must be a valid UUID.',
        },
        evidence: [],
        occurredAtEvent: 3,
        attempt: 0,
      },
    },
    20,
    'framing',
  );

  it('names the flag and the value DeFlow passed', () => {
    const line = human().event(refused);

    expect(line).toContain('--session-id');
    expect(line).toContain('run_20260813T110608Z_379fc8-framing');
    expect(line).toContain('agent.nonzero-exit');
  });

  it('bounds a refused value, because one of them is a whole prompt', () => {
    // `-p` carries the packet, and a binary that refuses *that* flag is a real
    // case: the bundled agent answers `unknown argument "-p"` when it is handed
    // Claude Code's argv. Without a bound, four hundred words of prompt land in
    // the middle of a transcript somebody is reading.
    const wordy = event(
      'node.failed',
      {
        node: 'framing',
        attempt: 0,
        failure: {
          reason: 'agent.nonzero-exit',
          class: 'permanent',
          message: 'the agent refused -p',
          detail: { flag: '-p', value: `Safety constraints (pinned):\n${'word '.repeat(200)}` },
          evidence: [],
          occurredAtEvent: 3,
          attempt: 0,
        },
      },
      21,
      'framing',
    );

    const line = human().event(wordy);

    // Wrapped under itself by the layout, as every long detail is — so the
    // claim is about the *bound*, not about the line breaks.
    expect(line).toContain('-p Safety');
    expect(line).toContain('…');
    expect(line.replaceAll(/\s+/g, ' ')).toContain('-p Safety constraints (pinned): word word');
    expect(line.length).toBeLessThan(400);
  });

  it('says nothing extra for a failure that is not about an argument', () => {
    const line = human().event(failed(0, 3));

    expect(line).not.toContain('--');
  });

  it('--json carries the same detail, unrendered', () => {
    const rendered = json().event(refused);

    expect(rendered).not.toContain(ESC);
    const parsed = JSON.parse(rendered) as {
      payload: { failure: { class: string; detail: { flag: string; value: string } } };
    };
    expect(parsed.payload.failure.class).toBe('permanent');
    expect(parsed.payload.failure.detail.flag).toBe('--session-id');
    expect(parsed.payload.failure.detail.value).toBe('run_20260813T110608Z_379fc8-framing');
  });
});
