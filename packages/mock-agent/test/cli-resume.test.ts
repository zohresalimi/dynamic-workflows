/**
 * KAR-05.5 — the two flags a resume spec needs on the mock: how much history
 * `session/load` replays, and where the frames the client sent are recorded.
 *
 * `--wire-log` is the witness for "a session/resume frame was sent" and for
 * its negative. It records what arrived **at the agent**, on the far side of a
 * real pipe, which is the only observation that can distinguish "DeFlow chose
 * not to send it" from "DeFlow sent it and the agent had no handler".
 */
import { expect, it, describe as suite } from 'vitest';
import { parseArgv } from '../src/cli.ts';

suite('--load-history', () => {
  it('sets how many historical notifications session/load replays', () => {
    const parsed = parseArgv(['--load-history', '400']);
    expect(parsed).toMatchObject({ kind: 'run', options: { loadHistory: 400 } });
  });

  it('defaults to none, so an unasked-for load replays nothing', () => {
    expect(parseArgv([])).toMatchObject({ kind: 'run', options: { loadHistory: 0 } });
  });

  it('refuses a value that is not a non-negative integer', () => {
    expect(parseArgv(['--load-history', 'lots'])).toMatchObject({ kind: 'error' });
    expect(parseArgv(['--load-history'])).toMatchObject({ kind: 'error' });
  });
});

suite('--wire-log', () => {
  it('takes a path', () => {
    expect(parseArgv(['--wire-log', '/tmp/wire.ndjson'])).toMatchObject({
      kind: 'run',
      options: { wireLog: '/tmp/wire.ndjson' },
    });
  });

  it('is null when absent', () => {
    expect(parseArgv([])).toMatchObject({ kind: 'run', options: { wireLog: null } });
  });

  it('refuses an empty value rather than writing somewhere surprising', () => {
    expect(parseArgv(['--wire-log'])).toMatchObject({ kind: 'error' });
    expect(parseArgv(['--wire-log', '--seed'])).toMatchObject({ kind: 'error' });
  });
});
