/**
 * KAR-03.7 — where the global data directory is
 * (docs/16-repo-layout.md §7.2).
 *
 * A pure function of the environment, so it is a unit test: the lease, the
 * ledger and every blob hang off this one answer, and getting it wrong means
 * two daemons that believe they are alone because they are looking at
 * different directories.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { DATA_DIR_ENV, resolveDataDir } from './data-dir.ts';

suite('resolveDataDir', () => {
  it(`prefers ${DATA_DIR_ENV}, which is how a test gets its own`, () => {
    expect(resolveDataDir({ [DATA_DIR_ENV]: '/tmp/somewhere' })).toBe('/tmp/somewhere');
  });

  it('falls back to $XDG_DATA_HOME/DeFlow', () => {
    expect(resolveDataDir({ XDG_DATA_HOME: '/home/dev/.local/share' })).toBe(
      '/home/dev/.local/share/DeFlow',
    );
  });

  it('falls back to ~/.DeFlow when neither is set', () => {
    expect(resolveDataDir({})).toBe(join(homedir(), '.DeFlow'));
  });

  it('ignores an empty or relative XDG_DATA_HOME, as the spec requires', () => {
    // The XDG base directory specification: a relative path is invalid and
    // must be ignored, not resolved against the working directory — which
    // would give one daemon two data directories depending on where it was
    // started from, and that is the failure the lease cannot see.
    expect(resolveDataDir({ XDG_DATA_HOME: '' })).toBe(join(homedir(), '.DeFlow'));
    expect(resolveDataDir({ XDG_DATA_HOME: 'relative/share' })).toBe(join(homedir(), '.DeFlow'));
  });

  it('returns an absolute path whatever it was given', () => {
    expect(resolveDataDir({ [DATA_DIR_ENV]: 'data' })).toBe(join(process.cwd(), 'data'));
  });
});
