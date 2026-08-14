/**
 * KAR-19.6 test plan #2 / EPIC-19-S38 — the mode is stated, never guessed, and
 * never escalated behind you.
 *
 * Unit, and pure, because every claim is about what the command **says** and
 * what it puts in the request body — neither of which needs a daemon. The wire
 * itself is asserted over a real one in
 * `../../daemon/test/integration/cancel-unstarted.test.ts` and end to end in
 * `../../../e2e/cancel.test.ts`.
 *
 * The third suite is the one with teeth. An automatic escalation from
 * `cooperative` to `forceful` would make `--force` decorative and would
 * silently truncate the transcript of every long-running node — which is the
 * artefact an operator cancels a run in order to read.
 *
 * Verifies: EPIC-19-S38 · KAR-19.6 AC1, AC2, AC6, AC8
 */
import { invalidCancelModeMessage, RUN_STATUS_LABELS } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  type CancelAnswer,
  cancelModeSentence,
  parseCancelArgs,
  renderCancel,
  runCancel,
} from './cancel.ts';
import { RUN_EXIT_CODES } from './run/exit-codes.ts';

const RUN = 'run_20260812T133401Z_318740';

const parsed = (argv: readonly string[]) => {
  const result = parseCancelArgs(argv);
  if (!result.ok) throw new Error(`expected ${argv.join(' ')} to parse: ${result.message}`);
  return result.args;
};

const answer = (over: Partial<CancelAnswer> = {}): CancelAnswer => ({
  runId: RUN,
  mode: 'cooperative',
  status: 'cancelling',
  appended: true,
  seq: 12,
  ...over,
});

suite('EPIC-19-S38 — every invocation says what it did (AC2)', () => {
  it('sends cooperative when no mode was asked for, and names what that means', () => {
    const args = parsed([RUN]);
    expect(args).toEqual({ runId: RUN, mode: 'cooperative' });

    // The sentence, unwrapped: the shared renderer is what folds it to the
    // terminal's width (KAR-18.9), and asserting on the folded text would be
    // asserting about the column count rather than about the words.
    expect(cancelModeSentence('cooperative')).toContain('flush its transcript');
    expect(renderCancel(answer({ mode: 'cooperative' }))).toContain('cooperative');
  });

  it('sends forceful under --force, and names the ladder and the cost of it', () => {
    expect(parsed([RUN, '--force'])).toEqual({ runId: RUN, mode: 'forceful' });

    const sentence = cancelModeSentence('forceful');
    // F5.7's ladder, named rung by rung rather than as "the kill switch".
    expect(sentence).toContain('session/cancel');
    expect(sentence).toContain('SIGTERM');
    expect(sentence).toContain('SIGKILL');
    expect(sentence).toContain('truncated');
    expect(renderCancel(answer({ mode: 'forceful' }))).toContain('forceful');
  });

  it('accepts --mode as the long spelling of the same choice', () => {
    expect(parsed([RUN, '--mode', 'forceful'])).toEqual({ runId: RUN, mode: 'forceful' });
    expect(parsed([RUN, '--mode', 'cooperative'])).toEqual({ runId: RUN, mode: 'cooperative' });
  });

  it('describes each mode differently, so the two are never confusable', () => {
    expect(cancelModeSentence('cooperative')).not.toBe(cancelModeSentence('forceful'));
  });
});

suite('EPIC-19-S38 — a mode the daemon does not have (AC2)', () => {
  it('refuses with the daemon’s own sentence and the closed list', () => {
    const result = parseCancelArgs([RUN, '--mode', 'aggressive']);
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.message;
    expect(message).toContain(invalidCancelModeMessage());
    expect(message).toContain('"cooperative"');
    expect(message).toContain('"forceful"');
  });

  it('refuses before any request is made', async () => {
    const result = await runCancel({
      argv: [RUN, '--mode', 'aggressive'],
      env: {},
      findDaemon: () => {
        throw new Error('the CLI looked for a daemon before validating the mode');
      },
    });

    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain(invalidCancelModeMessage());
    expect(result.stdout).toBe('');
  });

  it('refuses an unknown flag and a missing run id the same way', async () => {
    for (const argv of [[], [RUN, '--quietly'], ['--force']]) {
      const result = await runCancel({
        argv,
        env: {},
        findDaemon: () => {
          throw new Error('the CLI looked for a daemon before parsing its argv');
        },
      });
      expect(result.exitCode, argv.join(' ')).toBe(64);
    }
  });
});

suite('EPIC-19-S38 — cooperative does not become forceful by itself (AC8)', () => {
  it('reports the run as still cancelling and names --force as the operator’s next move', () => {
    const printed = renderCancel(answer({ mode: 'cooperative', status: 'cancelling' }));
    expect(printed).toContain(RUN_STATUS_LABELS.cancelling);
    expect(printed).toContain('--force');
  });

  it('never suggests escalating a cancel that was already forceful', () => {
    expect(renderCancel(answer({ mode: 'forceful', status: 'cancelling' }))).not.toContain(
      '--force to stop',
    );
  });
});

suite('EPIC-19-S41 — a run that had already ended (AC6)', () => {
  it('says so, says how it ended, and exits 0', () => {
    const printed = renderCancel(answer({ status: 'completed', appended: false }));
    expect(printed).toContain('already ended');
    expect(printed).toContain(RUN_STATUS_LABELS.completed);
  });

  it('prints the terminal state of a run this command ended', () => {
    expect(renderCancel(answer({ status: 'aborted', appended: true }))).toContain(
      RUN_STATUS_LABELS.aborted,
    );
  });
});

suite('KAR-19.6 AC1 — no operator is sent to a bearer token', () => {
  it('never names curl or the token file in anything it prints', () => {
    const printed = [
      renderCancel(answer({ mode: 'cooperative' })),
      renderCancel(answer({ mode: 'forceful', status: 'aborted' })),
      renderCancel(answer({ status: 'completed', appended: false })),
    ].join('\n');
    expect(printed).not.toContain('curl');
    expect(printed).not.toContain('daemon.json');
    expect(printed).not.toContain('Authorization');
  });
});

suite('KAR-19.6 AC1 — the exit codes come from the shipped table', () => {
  it('exits daemonRefused when nothing is listening, without a stack trace', async () => {
    const result = await runCancel({
      argv: [RUN],
      env: {},
      findDaemon: () => Promise.resolve(null),
    });

    expect(result.exitCode).toBe(RUN_EXIT_CODES.daemonRefused);
    expect(result.stderr).toContain('no daemon');
    expect(result.stderr).not.toContain('    at ');
  });
});
