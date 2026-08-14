/**
 * KAR-20.2 — the decisions `setup` makes before it touches anything.
 *
 * Everything in `./plan.ts` is a pure function over a machine description,
 * which is what makes the two cases nobody can stage on their own laptop
 * assertable: a `win32` platform, and a `fish` user on a Linux box. The rest of
 * the story — the subprocesses, the profile write, the prompt — is integration,
 * because every claim there is a claim about a machine.
 *
 * Verifies: EPIC-20-S23 (the mapping half), EPIC-20-S24 (the Windows half),
 * EPIC-20-S18 (the "a report with a fail never exits 0" invariant) ·
 * AC3, AC7, AC8, AC13 · test plan #13
 */
import { delimiter, join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import {
  exitCodeFor,
  freshShellPath,
  parseVersion,
  profileTarget,
  SETUP_STEPS,
  type SetupStep,
  shellKind,
  windowsRefusal,
} from './plan.ts';

const HOME = '/home/alice';
const BIN = '/home/alice/.npm-global/bin';

const step = (id: SetupStep['id'], state: SetupStep['state']): SetupStep => ({
  id,
  state,
  detail: `${id} is ${state}`,
});

suite('the five steps are one ordered list (AC2)', () => {
  it('names install, link, verify, doctor and adapters, in that order', () => {
    expect(SETUP_STEPS).toEqual(['install', 'link', 'verify', 'doctor', 'adapters']);
  });
});

suite('the profile file is chosen by name, never by assumption (EPIC-20-S23, AC7)', () => {
  const rows = [
    { shell: '/bin/zsh', platform: 'darwin', file: join(HOME, '.zshrc') },
    { shell: '/usr/bin/zsh', platform: 'linux', file: join(HOME, '.zshrc') },
    { shell: '/bin/bash', platform: 'darwin', file: join(HOME, '.bash_profile') },
    { shell: '/usr/bin/bash', platform: 'linux', file: join(HOME, '.bashrc') },
    {
      shell: '/usr/local/bin/fish',
      platform: 'darwin',
      file: join(HOME, '.config/fish/config.fish'),
    },
    { shell: '/usr/bin/fish', platform: 'linux', file: join(HOME, '.config/fish/config.fish') },
  ] as const;

  for (const row of rows) {
    it(`sends ${row.shell} on ${row.platform} to ${row.file}`, () => {
      const target = profileTarget({
        shell: row.shell,
        platform: row.platform,
        home: HOME,
        binDir: BIN,
      });
      expect(target.file).toBe(row.file);
      expect(target.line).toContain(BIN);
    });
  }

  it('writes fish syntax into config.fish and never "export PATH="', () => {
    // `export PATH=…` is not fish syntax, and a line that errors on every new
    // terminal is worse than doing nothing at all.
    const fish = profileTarget({
      shell: '/usr/bin/fish',
      platform: 'linux',
      home: HOME,
      binDir: BIN,
    });
    expect(fish.line).toBe(`fish_add_path ${BIN}`);
    expect(fish.line).not.toContain('export PATH=');

    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const posix = profileTarget({ shell, platform: 'linux', home: HOME, binDir: BIN });
      expect(posix.line).toBe(`export PATH="${BIN}:$PATH"`);
    }
  });

  it('is a warn with a line and no file for an unrecognised $SHELL', () => {
    const target = profileTarget({
      shell: '/usr/bin/nonsense',
      platform: 'linux',
      home: HOME,
      binDir: BIN,
    });
    expect(target.kind).toBe('unknown');
    expect(target.file).toBeNull();
    // Still a line worth printing: an operator who is told nothing has to
    // work out both the directory and the syntax themselves.
    expect(target.line).toBe(`export PATH="${BIN}:$PATH"`);
  });

  it('reads the shell by name rather than by path', () => {
    expect(shellKind('/opt/homebrew/bin/zsh')).toBe('zsh');
    expect(shellKind('/bin/bash')).toBe('bash');
    expect(shellKind('/usr/local/bin/fish')).toBe('fish');
    expect(shellKind('/usr/bin/nonsense')).toBe('unknown');
    expect(shellKind(undefined)).toBe('unknown');
    expect(shellKind('')).toBe('unknown');
  });
});

suite('the PATH a fresh login shell would have (AC3)', () => {
  it('drops the npx directory this process is running from', () => {
    // The whole reason verification is a subprocess with a computed PATH: a
    // `setup` started by `npx deflow setup` has the npx cache's `.bin` on its
    // own PATH, so `deflow` resolves inside this very process — and asserting
    // on that would be the 2026-08-12 failure with a green tick over it.
    const envPath = [
      '/tmp/npm-cache/_npx/1a2b3c4d/node_modules/.bin',
      '/usr/local/bin',
      '/usr/bin',
    ].join(delimiter);

    expect(freshShellPath({ envPath, add: [] }).split(delimiter)).toEqual([
      '/usr/local/bin',
      '/usr/bin',
    ]);
  });

  it('drops any node_modules/.bin, which no login shell has', () => {
    const envPath = ['/repo/node_modules/.bin', '/usr/bin'].join(delimiter);
    expect(freshShellPath({ envPath, add: [] }).split(delimiter)).toEqual(['/usr/bin']);
  });

  it('adds the directories the profile now provides, once, at the front', () => {
    // Prepending is what an `export PATH="<dir>:$PATH"` line does, including
    // to a directory that was already there — so a repeated entry keeps the
    // prepended position and appears exactly once, never twice.
    const envPath = ['/usr/local/bin', '/usr/bin'].join(delimiter);
    expect(freshShellPath({ envPath, add: [BIN, '/usr/bin'] }).split(delimiter)).toEqual([
      BIN,
      '/usr/bin',
      '/usr/local/bin',
    ]);
  });

  it('survives an empty PATH and empty entries', () => {
    expect(freshShellPath({ envPath: '', add: [BIN] })).toBe(BIN);
    expect(freshShellPath({ envPath: `${delimiter}/usr/bin${delimiter}`, add: [] })).toBe(
      '/usr/bin',
    );
  });
});

suite('a version is read, never assumed (AC3)', () => {
  it('takes a bare semver off stdout', () => {
    expect(parseVersion('0.1.0\n')).toBe('0.1.0');
    expect(parseVersion('  1.2.3-rc.1  \n')).toBe('1.2.3-rc.1');
  });

  it('refuses anything that is not one', () => {
    // The second scenario of EPIC-20-S14: a `deflow` that exits 0 and prints
    // something unreadable is a failed verification, not a pass.
    for (const stdout of ['', '\n', 'command not found\n', 'DeFlow', 'v', '1.2']) {
      expect([stdout, parseVersion(stdout)]).toEqual([stdout, null]);
    }
  });

  it('reads the last line, which is where a shell leaves it', () => {
    expect(parseVersion('some/path/deflow\n0.1.0\n')).toBe('0.1.0');
  });
});

suite('a report with a fail never exits 0 (EPIC-20-S18, AC8)', () => {
  it('is non-zero whenever any step failed, whatever the others said', () => {
    for (const failed of SETUP_STEPS) {
      const steps = SETUP_STEPS.map((id) => step(id, id === failed ? 'fail' : 'ok'));
      expect([failed, exitCodeFor(steps)]).not.toEqual([failed, 0]);
    }
  });

  it('is 0 for ok, warn and skipped — a degraded machine is not a failed install (AC9)', () => {
    expect(exitCodeFor(SETUP_STEPS.map((id) => step(id, 'ok')))).toBe(0);
    expect(
      exitCodeFor([
        step('install', 'ok'),
        step('link', 'warn'),
        step('verify', 'ok'),
        step('doctor', 'warn'),
        step('adapters', 'skipped'),
      ]),
    ).toBe(0);
  });
});

suite('Windows is refused in one sentence, before anything is touched (EPIC-20-S24, AC13)', () => {
  it('names NF5 and WSL2 and does not pretend to have tried', () => {
    const sentence = windowsRefusal();
    expect(sentence).toContain('NF5');
    expect(sentence).toContain('WSL2');
    // One sentence, and it ends in a newline like every other refusal the CLI
    // writes to stderr.
    expect(sentence.trimEnd().split('\n')).toHaveLength(1);
    expect(sentence.endsWith('\n')).toBe(true);
  });
});
