/**
 * KAR-04.4 AC1, AC5 — the argv surface for `--capabilities`,
 * `--capabilities-file` and `--dishonest-capabilities`.
 *
 * Mirrors `test/pathological-scenarios.test.ts`'s style of exercising
 * `parseArgv` directly: this is the "parser half" of the story, fast and at
 * unit level, leaving the real over-the-wire behaviour to the integration
 * specs under `test/integration/`.
 *
 * Verifies: KAR-04.4 · AC1, AC5 · test plan row 6 (the parser half)
 */
import { expect, it, describe as suite } from 'vitest';
import { CAPABILITY_PROFILE_NAMES } from '../src/capability-profiles.ts';
import { DISHONEST_CAPABILITY_METHODS, parseArgv, USAGE } from '../src/cli.ts';

suite('--capabilities <name>', () => {
  it('selects a named profile', () => {
    const parsed = parseArgv(['--capabilities', 'claude']);
    if (parsed.kind !== 'run') throw new Error(`did not parse: ${JSON.stringify(parsed)}`);
    expect(parsed.options.capabilities).toEqual({ kind: 'name', name: 'claude' });
  });

  it('rejects an unknown profile, listing every valid name', () => {
    const parsed = parseArgv(['--capabilities', 'antigravity']);
    expect(parsed.kind).toBe('error');
    if (parsed.kind !== 'error') throw new Error('unreachable');
    for (const name of CAPABILITY_PROFILE_NAMES) expect(parsed.message).toContain(name);
    // AC5: never a silent fallback to a default profile.
    expect(parsed.message).not.toMatch(/default/i);
  });

  it('requires a value', () => {
    const parsed = parseArgv(['--capabilities']);
    expect(parsed.kind).toBe('error');
  });
});

suite('--capabilities-file <path>', () => {
  it('records the path without reading it — parseArgv does no I/O', () => {
    const parsed = parseArgv(['--capabilities-file', '/tmp/whatever-caps.json']);
    if (parsed.kind !== 'run') throw new Error(`did not parse: ${JSON.stringify(parsed)}`);
    expect(parsed.options.capabilities).toEqual({
      kind: 'file',
      path: '/tmp/whatever-caps.json',
    });
  });

  it('requires a value', () => {
    const parsed = parseArgv(['--capabilities-file']);
    expect(parsed.kind).toBe('error');
  });

  it('conflicts with --capabilities in either order', () => {
    expect(parseArgv(['--capabilities', 'claude', '--capabilities-file', '/tmp/x.json']).kind).toBe(
      'error',
    );
    expect(parseArgv(['--capabilities-file', '/tmp/x.json', '--capabilities', 'claude']).kind).toBe(
      'error',
    );
  });
});

suite('--dishonest-capabilities <capability>', () => {
  it('accepts each of the five documented capability paths', () => {
    for (const capability of Object.keys(DISHONEST_CAPABILITY_METHODS)) {
      const parsed = parseArgv([
        '--capabilities',
        'claude',
        '--dishonest-capabilities',
        capability,
      ]);
      if (parsed.kind !== 'run') throw new Error(`${capability} did not parse`);
      expect(parsed.options.dishonestCapability).toBe(capability);
    }
  });

  it('rejects an unknown capability path', () => {
    const parsed = parseArgv(['--dishonest-capabilities', 'session.teleport']);
    expect(parsed.kind).toBe('error');
    if (parsed.kind !== 'error') throw new Error('unreachable');
    for (const capability of Object.keys(DISHONEST_CAPABILITY_METHODS)) {
      expect(parsed.message).toContain(capability);
    }
  });

  it('requires a value', () => {
    const parsed = parseArgv(['--dishonest-capabilities']);
    expect(parsed.kind).toBe('error');
  });

  it('is absent by default', () => {
    const parsed = parseArgv([]);
    if (parsed.kind !== 'run') throw new Error('did not parse');
    expect(parsed.options.dishonestCapability).toBeNull();
    expect(parsed.options.capabilities).toEqual({ kind: 'default' });
  });
});

suite('--help documents the new flags', () => {
  it('mentions --capabilities, --capabilities-file and --dishonest-capabilities', () => {
    expect(USAGE).toContain('--capabilities');
    expect(USAGE).toContain('--capabilities-file');
    expect(USAGE).toContain('--dishonest-capabilities');
  });
});
