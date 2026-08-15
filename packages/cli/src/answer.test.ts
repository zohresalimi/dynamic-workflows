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
import { gateAnswerRequest, SPEC_GATE_NODE } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { parseAnswerArgs, runAnswer } from './answer.ts';

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

/**
 * KAR-22.5 AC2 — this command and the browser's gate panel build their request
 * with the same function, so there is one answer path rather than two.
 *
 * Asserted on the wire rather than on an internal call: what has to be true is
 * that the bytes `deflow answer` puts on the socket are `gateAnswerRequest`'s
 * path and body, and a spec that asserted the helper was *called* would still
 * pass if the result were then rebuilt by hand.
 *
 * Verifies: EPIC-22-S60 · KAR-22.5 AC2 · test plan #1
 */
suite('EPIC-22-S60 — one answer path, shared with the browser', () => {
  const sent = async (argv: readonly string[]): Promise<{ url: string; body: unknown }> => {
    const seen: { url: string; body: unknown }[] = [];
    const result = await runAnswer({
      argv,
      findDaemon: () =>
        Promise.resolve({
          baseUrl: 'http://127.0.0.1:7777',
          token: 'tkn',
          pid: 4242,
          autostarted: false,
        }),
      fetch: ((url: string, init: { body: string }) => {
        seen.push({ url, body: JSON.parse(init.body) as unknown });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }) as never,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    return seen[0] as { url: string; body: unknown };
  };

  it('sends the spec gate to the endpoint the shared builder names', async () => {
    const request = gateAnswerRequest({ runId: RUN, gate: SPEC_GATE_NODE, optionId: 'approve' });
    const wire = await sent([RUN, '--gate', SPEC_GATE_NODE, '--option', 'approve']);

    expect(wire.url).toBe(`http://127.0.0.1:7777${request?.path ?? ''}`);
    expect(wire.body).toEqual(request?.body);
  });

  it('sends a rejection’s reason in the field the shared builder puts it in', async () => {
    const request = gateAnswerRequest({
      runId: RUN,
      gate: SPEC_GATE_NODE,
      optionId: 'reject',
      text: 'the scope is wrong',
    });
    const wire = await sent([
      RUN,
      '--gate',
      SPEC_GATE_NODE,
      '--option',
      'reject',
      '--text',
      'the scope is wrong',
    ]);

    expect(wire.url).toBe(`http://127.0.0.1:7777${request?.path ?? ''}`);
    expect(wire.body).toEqual(request?.body);
  });

  it('sends every other gate to nodes/:nodeId/respond, as the builder does', async () => {
    const request = gateAnswerRequest({ runId: RUN, gate: 'review-changes', optionId: 'approve' });
    const wire = await sent([RUN, '--gate', 'review-changes', '--option', 'approve']);

    expect(wire.url).toBe(`http://127.0.0.1:7777${request?.path ?? ''}`);
    expect(wire.body).toEqual(request?.body);
  });
});
