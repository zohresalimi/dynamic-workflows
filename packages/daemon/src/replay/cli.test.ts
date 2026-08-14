/**
 * KAR-16.5 AC1, AC4, AC8 — the argv `deflow replay` is invoked with.
 *
 * Verifies: EPIC-16-S31, EPIC-16-S33 (the dev-loop scenario) · AC1, AC4, AC8
 *
 * `deflow replay fixtures/three-patches.jsonl --speed 20x --port 7777` is the
 * command the epic writes out in full, and `deflow replay gate-failure-repair
 * --speed 50x` is the one anybody actually types — *"jumps straight to a failed
 * gate"*. Both resolve here, and a name that is neither is refused with the
 * corpus listed, because the failure mode this prevents is a harness that boots
 * cheerfully against a fixture that does not exist and serves an empty run.
 */
import { expect, it, describe as suite } from 'vitest';
import { BadReplayArgv, parseReplayArgv, resolveFixture } from './cli.ts';

suite('parsing the command line', () => {
  it('takes a fixture, a speed and a port', () => {
    expect(parseReplayArgv(['three-patches', '--speed', '20x', '--port', '7777'])).toEqual({
      fixture: 'three-patches',
      speed: { kind: 'rate', factor: 20 },
      port: 7777,
      paused: false,
      dev: false,
      dataDir: undefined,
    });
  });

  it('defaults to 1x on the daemon’s own port', () => {
    const parsed = parseReplayArgv(['happy-path-12']);
    expect(parsed.speed).toEqual({ kind: 'rate', factor: 1 });
    expect(parsed.port).toBe(7777);
  });

  it('accepts --speed=max and --port=0 in the equals form', () => {
    const parsed = parseReplayArgv(['happy-path-12', '--speed=max', '--port=0']);
    expect(parsed.speed).toEqual({ kind: 'max' });
    expect(parsed.port).toBe(0);
  });

  it('carries --paused, --dev and --data-dir through', () => {
    const parsed = parseReplayArgv(['happy-path-12', '--paused', '--dev', '--data-dir', '/tmp/x']);
    expect(parsed.paused).toBe(true);
    expect(parsed.dev).toBe(true);
    expect(parsed.dataDir).toBe('/tmp/x');
  });

  it('refuses an invocation with no fixture', () => {
    expect(() => parseReplayArgv([])).toThrow(BadReplayArgv);
    expect(() => parseReplayArgv(['--speed', '20x'])).toThrow(/fixture/i);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    // A silently ignored `--speedx 20` is forty recorded minutes of waiting
    // that reads as a hung harness.
    expect(() => parseReplayArgv(['happy-path-12', '--speedx', '20'])).toThrow(/--speedx/);
  });

  it('refuses a port that is not a port', () => {
    expect(() => parseReplayArgv(['happy-path-12', '--port', 'seven'])).toThrow(/port/i);
    expect(() => parseReplayArgv(['happy-path-12', '--port', '70000'])).toThrow(/port/i);
  });
});

suite('resolving which recording to serve', () => {
  it('takes a corpus name', () => {
    expect(resolveFixture('three-patches')).toMatch(/three-patches\/events\.jsonl$/);
  });

  it('takes the path the epic writes out, pointing straight at the file', () => {
    const path = resolveFixture('test/fixtures/runs/happy-path-12/events.jsonl');
    expect(path).toMatch(/happy-path-12\/events\.jsonl$/);
  });

  it('names the whole corpus when the fixture is not one of them', () => {
    expect(() => resolveFixture('gate-fail-repair')).toThrow(/gate-failure-repair/);
    expect(() => resolveFixture('gate-fail-repair')).toThrow(/stress-400/);
  });
});
