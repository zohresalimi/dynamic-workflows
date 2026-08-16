/**
 * KAR-21.5 AC1, AC3, AC7 / EPIC-21-S39, S43 — the ladder, as one decision.
 *
 * The whole of "it degrades honestly" is one question asked once: *may a region
 * of this terminal be redrawn?* Four answers, and the interesting part is that
 * two of them are **silent** and two of them **say why**.
 *
 * Silent is not laziness. AC1 is the epic's regression bar: on a pipe, in a
 * redirect and under `--json` the command writes exactly the bytes it wrote
 * before KAR-21.1 existed, and an extra sentence explaining a live view the
 * operator never asked for would break that golden as surely as an escape
 * sequence would. `TERM=dumb` and a short window are the other kind: the
 * operator *is* at a terminal and *would* have got a frame, so silently doing
 * less is the failure KAR-20.2 names — the step that could not be performed
 * says so.
 *
 * A pure function over four facts, so every rung of the ladder is a table row
 * rather than a terminal somebody has to open.
 *
 * Verifies: EPIC-21-S39, EPIC-21-S43 · AC1, AC3, AC7 · test plan #3, #7
 */
import { expect, it, describe as suite } from 'vitest';
import {
  DUMB_TERMINAL_LINE,
  liveViewDecision,
  MIN_TERMINAL_ROWS,
  shortTerminalLine,
} from './degrade.ts';
import { MIN_FRAME_ROWS } from './view.ts';

/** A terminal that can do everything: a real tty, a real TERM, room to spare. */
const capable = {
  isTty: true,
  json: false,
  env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
  rows: 24,
} as const;

suite('the live view is opened only where it can work (AC1, AC3, AC7)', () => {
  it('opens on an ordinary terminal', () => {
    const decision = liveViewDecision(capable);

    expect(decision.live).toBe(true);
    expect(decision.refusal).toBeNull();
    expect(decision.line).toBeNull();
  });

  it('is silent on a pipe, which is what AC1 pins (EPIC-21-S37)', () => {
    const decision = liveViewDecision({ ...capable, isTty: false });

    expect(decision.live).toBe(false);
    expect(decision.refusal).toBe('not-a-terminal');
    // The whole of AC1: not one byte more than the command printed before this
    // epic. A sentence here would be a new byte in every CI log.
    expect(decision.line).toBeNull();
  });

  it('is silent under --json, whose consumer is a parser', () => {
    const decision = liveViewDecision({ ...capable, json: true });

    expect(decision.live).toBe(false);
    expect(decision.refusal).toBe('json');
    expect(decision.line).toBeNull();
  });
});

suite('EPIC-21-S39 — TERM=dumb gets no frame, and is told why (AC3)', () => {
  it('refuses the frame on a terminal that cannot address the cursor', () => {
    const decision = liveViewDecision({ ...capable, env: { TERM: 'dumb' } });

    expect(decision.live).toBe(false);
    expect(decision.refusal).toBe('dumb-terminal');
    expect(decision.line).toBe(DUMB_TERMINAL_LINE);
  });

  it('says so in one line that names the cause', () => {
    // One line — a paragraph in front of a run is its own regression — and it
    // names TERM rather than describing a mood, because naming it is what lets
    // the operator change it.
    expect(DUMB_TERMINAL_LINE.split('\n')).toHaveLength(1);
    expect(DUMB_TERMINAL_LINE).toContain('dumb');
    expect(DUMB_TERMINAL_LINE).toContain('cursor');
  });

  it('stays silent when TERM=dumb and the output is a pipe anyway', () => {
    // AC1 outranks AC3: a redirected `TERM=dumb` run is a pipe first, and a
    // pipe's bytes are the golden's.
    const decision = liveViewDecision({ ...capable, isTty: false, env: { TERM: 'dumb' } });

    expect(decision.refusal).toBe('not-a-terminal');
    expect(decision.line).toBeNull();
  });
});

suite('EPIC-21-S43 — a window too short for the frame gets one sentence (AC7)', () => {
  it('refuses the frame below the stated minimum height', () => {
    const decision = liveViewDecision({ ...capable, rows: 8 });

    expect(decision.live).toBe(false);
    expect(decision.refusal).toBe('too-short');
    expect(decision.line).toBe(shortTerminalLine(8));
  });

  it('names the height it needs, which is what the operator can act on', () => {
    const line = shortTerminalLine(8);

    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('8');
    expect(line).toContain(String(MIN_TERMINAL_ROWS));
  });

  it('opens the frame at exactly the minimum, and refuses one row below it', () => {
    expect(liveViewDecision({ ...capable, rows: MIN_TERMINAL_ROWS }).live).toBe(true);
    expect(liveViewDecision({ ...capable, rows: MIN_TERMINAL_ROWS - 1 }).live).toBe(false);
  });

  it('derives the minimum from the frame budget rather than picking a number', () => {
    // The frame is a footer occupying at most a third of the window (AC7 of
    // KAR-21.1), and it is never useful below `MIN_FRAME_ROWS`. A window in
    // which those two cannot both hold is a window the frame would scroll
    // itself in — so the minimum is the arithmetic, not a taste.
    expect(MIN_TERMINAL_ROWS).toBe(MIN_FRAME_ROWS * 3);
  });
});
