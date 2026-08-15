/**
 * KAR-19.12 AC4 — `deflow answer`'s argv, refused rather than guessed at.
 *
 * The whole value of this command is that an operator who has read the block
 * `deflow run` printed can type what it told them to type. That makes the
 * parser's job narrow and its failure mode specific: it must never supply a
 * default for the gate or for the option, because a default here answers a
 * question the operator did not read.
 *
 * Verifies: EPIC-19-S80 · KAR-19.12 AC4 · test plan #3
 */
import { SPEC_GATE_NODE } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { parseAnswerArgs } from './answer.ts';

const RUN = 'run_20260814T013434Z_c984dd';

suite('AC4 — the three things an answer names', () => {
  it('takes the run, the gate and the option', () => {
    const parsed = parseAnswerArgs([RUN, '--gate', SPEC_GATE_NODE, '--option', 'approve']);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.runId).toBe(RUN);
    expect(parsed.args.gate).toBe(SPEC_GATE_NODE);
    expect(parsed.args.option).toBe('approve');
    expect(parsed.args.text).toBeNull();
  });

  it('carries a note when one is given', () => {
    const parsed = parseAnswerArgs([
      RUN,
      '--gate',
      SPEC_GATE_NODE,
      '--option',
      'reject',
      '--text',
      'the scope is wrong',
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.text).toBe('the scope is wrong');
  });
});

suite('AC4 — nothing is defaulted', () => {
  it('refuses with no run id, naming the command that lists them', () => {
    const parsed = parseAnswerArgs(['--gate', SPEC_GATE_NODE, '--option', 'approve']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('deflow status');
  });

  it('refuses with no --gate rather than assuming the spec gate', () => {
    const parsed = parseAnswerArgs([RUN, '--option', 'approve']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('--gate');
  });

  it('refuses with no --option rather than assuming the first one', () => {
    const parsed = parseAnswerArgs([RUN, '--gate', SPEC_GATE_NODE]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('--option');
  });

  it('refuses an unknown flag and a second run id', () => {
    expect(parseAnswerArgs([RUN, '--gate', 'g', '--option', 'o', '--wat']).ok).toBe(false);
    expect(parseAnswerArgs([RUN, 'run_other', '--gate', 'g', '--option', 'o']).ok).toBe(false);
  });

  it('consumes --no-color without acting on it, like every other command', () => {
    const parsed = parseAnswerArgs([
      RUN,
      '--no-color',
      '--gate',
      SPEC_GATE_NODE,
      '--option',
      'approve',
    ]);
    expect(parsed.ok).toBe(true);
  });
});

suite('AC4 — edit is refused honestly, and a rejection costs a reason', () => {
  it('refuses edit by naming what an edit actually carries', () => {
    const parsed = parseAnswerArgs([RUN, '--gate', SPEC_GATE_NODE, '--option', 'edit']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('amended');
    expect(parsed.message).toContain('/runs/');
  });

  it('refuses a rejection with nothing to say', () => {
    const parsed = parseAnswerArgs([RUN, '--gate', SPEC_GATE_NODE, '--option', 'reject']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('--text');
  });
});
