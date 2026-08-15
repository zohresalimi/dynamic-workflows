/**
 * KAR-20.2 — the half of `setup` that edits a file in the operator's home
 * directory.
 *
 * A tool that appends a line to a dotfile without saying which one is a tool
 * people uninstall, and a wrong line in a shell profile follows somebody into
 * every terminal they open for as long as they keep the machine. So the rules
 * here are stricter than anywhere else in the CLI: name the file, print the
 * line, ask, default to **no** on a bare Enter, write nothing at all when
 * nobody is there to answer, and be a fixpoint on the second run.
 *
 * Real files under a real fake `HOME`, and — for the concurrent case — two real
 * processes, because "two runs at once do not interleave" is a claim about
 * `open(2)` and about what the kernel does with two writers, and is unfalsifiable
 * in one event loop.
 *
 * Verifies: EPIC-20-S16, EPIC-20-S17, EPIC-20-S18, EPIC-20-S23 · AC5, AC6,
 * AC7, AC8 · test plan #4, #5, #6, #7
 */
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { plainStyle } from '../../src/render/style.ts';
import { runSetup, type SetupOptions, type SetupResult } from '../../src/setup/run.ts';
import { HERMETIC_PATH } from './support/cli-process.ts';
import { writeFakeDeflow, writeFakeNpmForSetup } from './support/setup-fixture.ts';

const CLI_BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));
const NODE_ONLY = HERMETIC_PATH.split(delimiter)[0] as string;
const VERSION = '0.4.2';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

interface Machine {
  readonly home: string;
  readonly binDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly line: string;
  profile(file: string): string | null;
}

/** A home directory, a global prefix nothing else knows about, and a `$SHELL`. */
async function machine(
  name: string,
  options: { readonly shell?: string; readonly seed?: readonly [string, string] } = {},
): Promise<Machine> {
  const home = join(tmp, `${name}-home`);
  const prefix = join(tmp, `${name}-prefix`);
  const binDir = join(prefix, 'bin');
  const toolsDir = join(tmp, `${name}-tools`);
  const staged = join(tmp, `${name}-staged`);
  const dataDir = join(tmp, `${name}-data`);
  const cwd = join(tmp, `${name}-cwd`);
  for (const dir of [home, binDir, toolsDir, staged, dataDir, cwd]) {
    await mkdir(dir, { recursive: true });
  }

  const installed = await writeFakeDeflow(staged, {
    version: VERSION,
    log: join(tmp, `${name}-deflow.jsonl`),
  });
  await writeFakeNpmForSetup(toolsDir, {
    log: join(tmp, `${name}-npm.jsonl`),
    prefix,
    // Both `bin` keys the manifest declares, because npm links both — a fixture
    // that installed only the command would make `verify` warn about a missing
    // `dfl` in every scenario in this file, for a reason none of them are about.
    installs: { [join(binDir, 'deflow')]: installed, [join(binDir, 'dfl')]: installed },
  });

  if (options.seed !== undefined) {
    const [file, contents] = options.seed;
    await mkdir(join(home, file, '..'), { recursive: true });
    writeFileSync(join(home, file), contents);
  }

  return {
    home,
    binDir,
    cwd,
    line: `export PATH="${binDir}:$PATH"`,
    env: {
      PATH: [toolsDir, NODE_ONLY].join(delimiter),
      HOME: home,
      SHELL: options.shell ?? '/bin/zsh',
      DeFlow_DATA_DIR: dataDir,
      DeFlow_LOG_LEVEL: 'silent',
    },
    profile: (file: string) => {
      const path = join(home, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
  };
}

const base = (host: Machine, overrides: Partial<SetupOptions> = {}): SetupOptions => ({
  cwd: host.cwd,
  env: host.env,
  platform: 'linux',
  from: 'deflow',
  clock: new TestClock(1_755_000_000_000),
  style: plainStyle(),
  isTty: () => false,
  ...overrides,
});

const linkStep = (result: SetupResult) => {
  const step = result.steps.find((entry) => entry.id === 'link');
  if (step === undefined) throw new Error('no link step');
  return step;
};

/**
 * A rendered report with every run of whitespace collapsed.
 *
 * KAR-18.9 AC4 wraps a long detail rather than truncating it, and the absolute
 * paths a temp directory produces are far longer than the 80 columns a piped
 * stdout gets — so the line an operator would copy is present but folded. The
 * *unfolded* form is asserted where it can be: in the step detail, in the
 * prompt question and in the JSON document, none of which the renderer touches.
 */
const unwrapped = (text: string): string => text.replaceAll(/\s+/g, ' ');

function scriptedPrompt(answer: string) {
  const asked: string[] = [];
  return {
    asked,
    prompt: async (question: string): Promise<string> => {
      asked.push(question);
      return answer;
    },
  };
}

suite('a profile is never edited without naming it first (EPIC-20-S16, AC5)', () => {
  const rows = [
    { answer: 'y', label: 'y', appended: true },
    { answer: 'n', label: 'n', appended: false },
    { answer: '', label: 'a bare Enter', appended: false },
  ] as const;

  for (const row of rows) {
    it(`answers "${row.label}" by ${row.appended ? 'appending one line' : 'writing nothing'}`, async () => {
      const before = '# my own zshrc\nalias ll="ls -l"\n';
      const host = await machine(`s16-${row.label.replace(/\W/g, '')}`, {
        seed: ['.zshrc', before],
      });
      const scripted = scriptedPrompt(row.answer);

      const result = await runSetup(base(host, { isTty: () => true, prompt: scripted.prompt }));

      // The file and the line are both printed *before* any write — asserted
      // through the question itself, which is the only thing shown first.
      expect(scripted.asked).toHaveLength(1);
      expect(scripted.asked[0]).toContain(join(host.home, '.zshrc'));
      expect(scripted.asked[0]).toContain(host.line);

      const after = host.profile('.zshrc') ?? '';
      if (row.appended) {
        expect(after.startsWith(before)).toBe(true);
        expect(after.split('\n').filter((line) => line.trim() === host.line)).toHaveLength(1);
        expect(linkStep(result).state).toBe('ok');
      } else {
        // Byte-identical: a bare Enter is *no*, the same default KAR-18.8 AC4
        // settled for the adapter offer, and the blast radius here is larger.
        expect(after).toBe(before);
        expect(linkStep(result).state).toBe('warn');
        expect(linkStep(result).detail).toContain(host.line);
        expect(unwrapped(result.stdout)).toContain(unwrapped(host.line));
      }
    });
  }

  it('writes without asking under --yes, and still says what it wrote', async () => {
    const host = await machine('s16-yes', { seed: ['.zshrc', ''] });
    const scripted = scriptedPrompt('y');

    const result = await runSetup(
      base(host, { yes: true, isTty: () => false, prompt: scripted.prompt }),
    );

    expect(scripted.asked).toEqual([]);
    expect(
      host
        .profile('.zshrc')
        ?.split('\n')
        .filter((line) => line.trim() === host.line),
    ).toHaveLength(1);
    expect(linkStep(result).detail).toContain(join(host.home, '.zshrc'));
    expect(linkStep(result).detail).toContain(host.line);
  });

  it('writes nothing at all with no TTY and no --yes, and prints the line', async () => {
    const host = await machine('s16-piped', { seed: ['.zshrc', '# mine\n'] });
    const scripted = scriptedPrompt('y');

    const result = await runSetup(base(host, { isTty: () => false, prompt: scripted.prompt }));

    expect(scripted.asked).toEqual([]);
    expect(host.profile('.zshrc')).toBe('# mine\n');
    expect(linkStep(result).detail).toContain(host.line);
    expect(unwrapped(result.stdout)).toContain(unwrapped(host.line));
    expect(unwrapped(result.stdout)).toContain(unwrapped(join(host.home, '.zshrc')));
    expect(linkStep(result).state).toBe('warn');
  });
});

suite('running it twice changes nothing the second time (EPIC-20-S17, AC6)', () => {
  it('appends one line, reports "already" and exits 0 on the second run', async () => {
    const host = await machine('s17', { seed: ['.zshrc', '# mine\n'] });

    const first = await runSetup(base(host, { yes: true }));
    const afterFirst = host.profile('.zshrc') ?? '';
    const second = await runSetup(base(host, { yes: true }));

    expect(host.profile('.zshrc')).toBe(afterFirst);
    expect(afterFirst.split('\n').filter((line) => line.trim() === host.line)).toHaveLength(1);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    for (const step of second.steps) expect([step.id, step.state]).toEqual([step.id, 'ok']);

    // AC6 — "already" rather than the work being done twice, for the two steps
    // that *do* work: the install and the profile edit. `verify`, `doctor` and
    // `adapters` deliberately run again and say so, because each of them is an
    // observation that changes nothing — and a second run that skipped the
    // verification on the grounds that the first one passed would be exactly
    // the inference this story exists to remove.
    for (const id of ['install', 'link'] as const) {
      const step = second.steps.find((entry) => entry.id === id);
      expect([id, /alread/i.test(step?.detail ?? '')]).toEqual([id, true]);
    }
    expect(second.steps.find((step) => step.id === 'verify')?.detail).toContain('--version');
  });

  it('does not interleave two concurrent runs into one file', async () => {
    const host = await machine('s17-concurrent', { seed: ['.zshrc', '# mine\n'] });

    const run = (): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [CLI_BIN, 'setup', '--yes', '--from', 'deflow', '--no-color'],
          { cwd: host.cwd, env: host.env, stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const err: string[] = [];
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString()));
        child.once('exit', (code) => resolve({ code, stderr: err.join('') }));
      });

    const [a, b] = await Promise.all([run(), run()]);

    expect([a.code, b.code], `${a.stderr}${b.stderr}`).toEqual([0, 0]);
    const after = host.profile('.zshrc') ?? '';
    expect(after.split('\n').filter((line) => line.trim() === host.line)).toHaveLength(1);
    // Nothing half-written: every line is either the operator's or ours.
    expect(after.startsWith('# mine\n')).toBe(true);
    expect(after.endsWith('\n')).toBe(true);
  }, 60_000);
});

suite('it cannot put the binary on PATH (EPIC-20-S18, AC8)', () => {
  it('fails with the errno, the exact line and the exact file, and exits non-zero', async () => {
    const host = await machine('s18', { seed: ['.zshrc', '# mine\n'] });
    const profile = join(host.home, '.zshrc');
    // The operator's own home, read-only: a managed machine, a restored backup
    // with the wrong owner, or a directory somebody chmod'd years ago.
    chmodSync(profile, 0o400);
    chmodSync(host.home, 0o500);

    try {
      const result = await runSetup(base(host, { yes: true }));
      const link = linkStep(result);

      expect(link.state).toBe('fail');
      expect(link.detail).toContain(profile);
      expect(link.detail).toMatch(/EACCES|EPERM|EROFS/);
      expect(link.detail).toContain(host.line);
      // AC8 — the summary block's first line is that next action.
      const summary = result.stdout.trimEnd().split('\n');
      const next = summary.findIndex((line) => line.startsWith('next: '));
      expect(next).toBeGreaterThanOrEqual(0);
      expect(unwrapped(summary.slice(next).join('\n'))).toContain(unwrapped(host.line));
      expect(link.action).toContain(host.line);
      expect(result.exitCode).not.toBe(0);
      // …and no step after link claims to have passed.
      const after = result.steps.slice(result.steps.findIndex((step) => step.id === 'link') + 1);
      expect(after.map((step) => step.state)).toEqual(['skipped', 'skipped', 'skipped']);
      expect(host.profile('.zshrc')).toBe('# mine\n');
    } finally {
      chmodSync(host.home, 0o700);
      chmodSync(profile, 0o600);
    }
  });
});

suite('the file per shell, and an unknown one (EPIC-20-S23, AC7)', () => {
  const rows = [
    { shell: '/bin/zsh', platform: 'darwin', file: '.zshrc', syntax: 'export PATH=' },
    { shell: '/bin/zsh', platform: 'linux', file: '.zshrc', syntax: 'export PATH=' },
    { shell: '/bin/bash', platform: 'darwin', file: '.bash_profile', syntax: 'export PATH=' },
    { shell: '/bin/bash', platform: 'linux', file: '.bashrc', syntax: 'export PATH=' },
    {
      shell: '/usr/bin/fish',
      platform: 'linux',
      file: '.config/fish/config.fish',
      syntax: 'fish_add_path',
    },
  ] as const;

  for (const row of rows) {
    it(`${row.shell} on ${row.platform} gets ${row.file}`, async () => {
      const host = await machine(`s23-${row.file.replace(/\W/g, '')}-${row.platform}`, {
        shell: row.shell,
      });

      const result = await runSetup(base(host, { yes: true, platform: row.platform }));

      const written = host.profile(row.file) ?? '';
      expect(written).toContain(host.binDir);
      expect(written).toContain(row.syntax);
      expect(linkStep(result).detail).toContain(join(host.home, row.file));
      // …and no other candidate file was touched.
      for (const other of ['.zshrc', '.bashrc', '.bash_profile', '.config/fish/config.fish']) {
        if (other === row.file) continue;
        expect([other, host.profile(other)]).toEqual([other, null]);
      }
    });
  }

  it('is a warn that writes nothing for an unrecognised $SHELL', async () => {
    const host = await machine('s23-unknown', { shell: '/usr/bin/nonsense' });

    const result = await runSetup(base(host, { yes: true }));

    expect(linkStep(result).state).toBe('warn');
    expect(linkStep(result).detail).toContain(host.line);
    expect(linkStep(result).detail).toMatch(/could not (?:work out|determine)/i);
    for (const file of ['.zshrc', '.bashrc', '.bash_profile', '.config/fish/config.fish']) {
      expect([file, host.profile(file)]).toEqual([file, null]);
    }
  });
});
