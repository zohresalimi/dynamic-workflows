/**
 * KAR-19.1 AC6, AC7 — what `deflow run`'s attached view says when a run stops
 * moving.
 *
 * The operator of 2026-08-12 watched a prompt that said `task submitted` and
 * then nothing, for an afternoon. F4.7's `run.stalled` is the event that exists
 * to break that silence — *"surfaced, never auto-killed"* — and until this story
 * nothing appended it and no surface rendered it.
 *
 * One line, and the line has three jobs: name the run, say how long it has been
 * idle, and name the next command. Anything less is a line the operator has to
 * act on without knowing what to do; anything more, once a second, is the log
 * people learn to scroll past.
 *
 * The run-level statuses come from `RUN_STATUS_LABELS` in `@DeFlow/core` — the
 * same table `deflow status` and the UI's run list render — so this view cannot
 * acquire a fourth word for a state the other two already have three.
 *
 * Verifies: EPIC-19-S4 (its CLI clause), EPIC-19-S7 · KAR-19.1 AC6, AC7
 */
import type { Event, EventKind, RunId } from '@DeFlow/core';
import { EVENT_SCHEMAS, parseEvent, RUN_STATUS_LABELS, RunIdSchema } from '@DeFlow/core';
import { expect, test as it, describe as suite } from 'vitest';
import { createRenderer } from '../src/run/render.ts';

const RUN: RunId = RunIdSchema.parse('run_20260812T133934Z_468702');
const TS = 1_754_812_800_000;

function event(kind: EventKind, payload: unknown, seq = 1): Event {
  const parsed = parseEvent({
    seq,
    runId: RUN,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload,
  });
  if (parsed.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}

const renderer = () => createRenderer({ runId: RUN, mode: 'human', isTty: () => false });

const stalled = (idleMs: number) =>
  event('run.stalled', { watermarkSeq: 4, idleMs, runningNodes: [] });

suite('the stall line (AC7)', () => {
  it('names the run, the idle time and deflow status as the next command', () => {
    const line = renderer().event(stalled(11 * 60_000));

    expect(line).toContain(RUN);
    expect(line).toContain('11m');
    expect(line).toContain('deflow status');
    // One line, wrapped or not — never a paragraph and never a stack trace.
    expect(line.trimEnd().split('\n').length).toBeLessThanOrEqual(3);
  });

  it('says stalled rather than failed: the run was not killed', () => {
    const line = renderer().event(stalled(11 * 60_000));

    expect(line).toContain('stalled');
    expect(line.toLowerCase()).not.toContain('failed');
    expect(line.toLowerCase()).not.toContain('killed');
  });

  it('renders the same event as NDJSON with no wording of its own', () => {
    const json = createRenderer({ runId: RUN, mode: 'json', isTty: () => false }).event(
      stalled(60_000),
    );

    expect(JSON.parse(json) as { kind: string }).toMatchObject({ kind: 'run.stalled' });
  });
});

suite('run-level statuses come from the shared table (AC6)', () => {
  it('prints needs-human with @DeFlow/core’s words', () => {
    const line = renderer().event(
      event('run.needs_human', { reason: 'budget', detail: 'ceiling' }),
    );

    expect(line).toContain(RUN_STATUS_LABELS['needs-human']);
  });

  it('prints paused, completed and aborted with the same table', () => {
    const paused = renderer().event(
      event('run.paused', { by: 'user', reason: 'the operator asked' }),
    );
    const completed = renderer().event(
      event('run.completed', { outcome: 'succeeded', criteriaSatisfied: [] }),
    );
    const aborted = renderer().event(
      event('run.aborted', { outcome: 'failed', criteriaSatisfied: [] }),
    );

    expect(paused).toContain(RUN_STATUS_LABELS.paused);
    expect(completed).toContain(RUN_STATUS_LABELS.completed);
    expect(aborted).toContain(RUN_STATUS_LABELS.aborted);
  });
});
