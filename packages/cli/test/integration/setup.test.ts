/**
 * KAR-20.2 — `deflow setup` against real machines.
 *
 * The owner's 2026-08-12 install is the specification: `pnpm link --global`
 * exited 0, printed a success, and produced no command — because pnpm's global
 * bin directory was not on `PATH` and nothing said so. Every scenario in this
 * file is an assertion that some part of that cannot happen silently again, and
 * every one of them is integration for the same reason: an exit code that lies
 * is indistinguishable from an exit code that does not, *unless you go and
 * look*. A mocked `spawn` returning 0 is the defect, not the test for it.
 *
 * Verifies: EPIC-20-S13, EPIC-20-S14, EPIC-20-S15, EPIC-20-S19, EPIC-20-S20,
 * EPIC-20-S21, EPIC-20-S22, EPIC-20-S24 (the no-egress half) · AC2, AC3, AC4,
 * AC9, AC10, AC11, AC12 · test plan #2, #3, #8, #9, #10, #11, #12
 */
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { createStyle, plainStyle } from '../../src/render/style.ts';
import { SETUP_STEPS, type SetupStep } from '../../src/setup/plan.ts';
import { runSetup, type SetupOptions, type SetupResult } from '../../src/setup/run.ts';
import { fakeBin } from './support/doctor-fixture.ts';
import {
  invocations,
  writeFakeDeflow,
  writeFakeNpmForSetup,
  writeFakePnpm,
} from './support/setup-fixture.ts';

const CLI_BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

/** A directory holding a `node` symlink and nothing else — the shebang problem,
 * solved without putting the developer's own global bin directory on PATH. */
import { HERMETIC_PATH } from './support/cli-process.ts';

const NODE_ONLY = HERMETIC_PATH.split(delimiter)[0] as string;

const VERSION = '0.4.2';
const CLAUDE_PKG = '@agentclientprotocol/claude-agent-acp';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

interface MachineOptions {
  /** Put the npm global bin directory on the operator's own PATH. */
  readonly binDirOnPath?: boolean;
  /** What the installed `deflow` does when it is asked for a doctor report. */
  readonly doctor?: 'healthy' | 'degraded' | 'crash';
  /** Install nothing: an `npm` that exits 0 and leaves the prefix empty. */
  readonly installsNothing?: boolean;
  /**
   * Install the command but not its short alias — what an older release, whose
   * `bin` map had no `dfl` in it, leaves behind on a machine that then re-runs
   * `setup`.
   */
  readonly withoutAlias?: boolean;
  /** Fail the install with this stderr instead — the no-egress case. */
  readonly npmFailure?: { readonly exitCode: number; readonly stderr: string };
  /** Vendor CLIs to put on PATH, for the adapters step. */
  readonly vendors?: readonly string[];
  /** `$SHELL`. `/bin/zsh` unless a spec says otherwise. */
  readonly shell?: string;
  /** Seed the profile file with these bytes before the run. */
  readonly profile?: string;
  /** Print this from `deflow --version` instead of a version. */
  readonly unparseableVersion?: string;
  /** Put the installed binary in the prefix before the run, so that the run is
   * a fixpoint and two runs of it produce byte-identical reports. */
  readonly preinstalled?: boolean;
  /**
   * Make `npm prefix -g` answer with a directory that does not exist, while
   * the install itself still succeeds — observed on 2026-08-15, see the suite
   * at the bottom of this file.
   */
  readonly prefixDoesNotExist?: boolean;
}

interface Machine {
  readonly home: string;
  readonly binDir: string;
  /** The bin directory `npm prefix -g` *claims*, which is `binDir` unless a
   * spec staged them apart. */
  readonly reportedBinDir: string;
  readonly toolsDir: string;
  readonly dataDir: string;
  readonly cwd: string;
  readonly profileFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly npmLog: string;
  readonly deflowLog: string;
  readonly pnpmLog: string;
  npm(): Promise<readonly (readonly string[])[]>;
  deflow(): Promise<readonly (readonly string[])[]>;
}

/**
 * A machine with a home, a global npm prefix, a tool directory and nothing
 * else on `PATH`.
 *
 * The staged package bytes live *outside* the prefix until the fake npm copies
 * them in, so "the install put a binary where the operator's next shell will
 * find it" is an observation rather than a fixture.
 */
async function machine(name: string, options: MachineOptions = {}): Promise<Machine> {
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

  const npmLog = join(tmp, `${name}-npm.jsonl`);
  const deflowLog = join(tmp, `${name}-deflow.jsonl`);
  const pnpmLog = join(tmp, `${name}-pnpm.jsonl`);

  const installed = await writeFakeDeflow(staged, {
    version: VERSION,
    log: deflowLog,
    doctor: options.doctor,
    unparseableVersion: options.unparseableVersion,
  });

  await writeFakeNpmForSetup(toolsDir, {
    log: npmLog,
    // The reported prefix and the real one are separate inputs on purpose: npm
    // answering with a directory nobody created is a staged fact here rather
    // than a thing that happens on somebody else's laptop.
    prefix: options.prefixDoesNotExist === true ? join(tmp, `${name}-ghost-prefix`) : prefix,
    // Both `bin` keys, because npm links every key the manifest declares —
    // modelling only `deflow` would make the alias untestable by construction.
    installs:
      options.installsNothing === true
        ? {}
        : {
            [join(binDir, 'deflow')]: installed,
            ...(options.withoutAlias === true ? {} : { [join(binDir, 'dfl')]: installed }),
          },
    failure: options.npmFailure,
  });

  if (options.preinstalled === true) {
    for (const name of options.withoutAlias === true ? ['deflow'] : ['deflow', 'dfl']) {
      copyFileSync(installed, join(binDir, name));
      chmodSync(join(binDir, name), 0o755);
    }
  }

  for (const vendor of options.vendors ?? []) await fakeBin(toolsDir, vendor);

  const shell = options.shell ?? '/bin/zsh';
  const profileFile = join(home, '.zshrc');
  if (options.profile !== undefined) writeFileSync(profileFile, options.profile);

  return {
    home,
    binDir,
    reportedBinDir:
      options.prefixDoesNotExist === true ? join(tmp, `${name}-ghost-prefix`, 'bin') : binDir,
    toolsDir,
    dataDir,
    cwd,
    profileFile,
    npmLog,
    deflowLog,
    pnpmLog,
    env: {
      PATH: [toolsDir, ...(options.binDirOnPath === true ? [binDir] : []), NODE_ONLY].join(
        delimiter,
      ),
      HOME: home,
      SHELL: shell,
      DeFlow_DATA_DIR: dataDir,
      DeFlow_LOG_LEVEL: 'silent',
    },
    npm: () => invocations(npmLog),
    deflow: () => invocations(deflowLog),
  };
}

const base = (host: Machine, overrides: Partial<SetupOptions> = {}): SetupOptions => ({
  cwd: host.cwd,
  env: host.env,
  platform: 'linux',
  // `from` is deliberately *not* set: the specifier `setup` installs when
  // nobody overrides it is part of what these specs are for, and an override
  // here would have hidden a default that fetches a stranger's package.
  clock: new TestClock(1_755_000_000_000),
  style: plainStyle(),
  isTty: () => false,
  ...overrides,
});

const stepOf = (result: SetupResult, id: SetupStep['id']): SetupStep => {
  const found = result.steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no ${id} step in the report`);
  return found;
};

const states = (result: SetupResult): Record<string, string> =>
  Object.fromEntries(result.steps.map((step) => [step.id, step.state]));

/** A prompt port that records what it was asked and answers `answer`. */
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

suite('five steps, in order, with a summary block (EPIC-20-S13, AC2)', () => {
  it('reports install, link, verify, doctor and adapters and exits 0 on a machine it can fix', async () => {
    const host = await machine('s13', { binDirOnPath: true });

    const result = await runSetup(base(host));

    expect(result.steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
    expect(states(result)).toEqual({
      install: 'ok',
      link: 'ok',
      verify: 'ok',
      doctor: 'ok',
      adapters: 'ok',
    });
    expect(result.exitCode).toBe(0);

    // AC2 — one report, through KAR-18.9's layer, ending in its summary block.
    for (const id of SETUP_STEPS) expect(result.stdout).toContain(id);
    expect(result.stdout.trimEnd().split('\n').at(-1)).toMatch(/^overall: /);
    // AC3 — the version was read out of a subprocess, not inferred.
    expect(stepOf(result, 'verify').detail).toContain(VERSION);
    expect(await host.deflow()).toContainEqual(['--version']);
  });

  it('skips the rest of the sequence when a step fails, and says why (EPIC-20-S13 scenario 2)', async () => {
    // An npm with no egress: the install fails, and nothing downstream of it
    // may report a state that reads like a pass.
    const host = await machine('s13-stop', {
      npmFailure: { exitCode: 1, stderr: 'npm error code ENOTFOUND\n' },
    });

    const result = await runSetup(base(host));

    expect(states(result)).toEqual({
      install: 'fail',
      link: 'skipped',
      verify: 'skipped',
      doctor: 'skipped',
      adapters: 'skipped',
    });
    for (const id of ['link', 'verify', 'doctor', 'adapters'] as const) {
      expect(stepOf(result, id).detail).toMatch(/install/);
    }
    // AC12 — no profile line and no partial link left behind.
    expect(existsSync(host.profileFile)).toBe(false);
    expect(existsSync(join(host.binDir, 'deflow'))).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('loses no information when every ANSI sequence is stripped (AC2)', async () => {
    // Preinstalled, so that both runs below are pure reads of the same machine
    // and any difference between them is the styling rather than the state.
    const host = await machine('s13-ansi', { binDirOnPath: true, preinstalled: true });

    const coloured = await runSetup(
      base(host, { style: createStyle({ isTty: true, columns: 80, env: { TERM: 'xterm' } }) }),
    );
    const plain = await runSetup(base(host));

    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ESC is the point
    const stripped = coloured.stdout.replaceAll(/\[[0-9;]*m/g, '');
    expect(stripped).toBe(plain.stdout);
  });
});

suite('a link that lied is caught (EPIC-20-S14, AC3)', () => {
  it('fails verification when the install exits 0 and puts nothing on PATH', async () => {
    // The 2026-08-12 defect in miniature: the bin directory *is* on PATH, npm
    // *did* exit 0, and there is still no command.
    const host = await machine('s14', { binDirOnPath: true, installsNothing: true });

    const result = await runSetup(base(host));

    expect(await host.npm()).toContainEqual(['install', '-g', 'deflowai']);
    expect(stepOf(result, 'install').state).not.toBe('fail');
    expect(stepOf(result, 'verify').state).toBe('fail');
    // It names what it ran and what happened, rather than "verification failed".
    expect(stepOf(result, 'verify').detail).toContain('deflow --version');
    expect(result.exitCode).not.toBe(0);
    // AC8 — and the summary block's next action is the line that would fix it.
    expect(result.stdout).toMatch(/next: /);
  });

  it('fails when the version is unreadable (EPIC-20-S14 scenario 2)', async () => {
    const host = await machine('s14-unreadable', {
      binDirOnPath: true,
      unparseableVersion: 'DeFlow, the workflow thing',
    });

    const result = await runSetup(base(host));

    expect(stepOf(result, 'verify').state).toBe('fail');
    expect(stepOf(result, 'verify').detail).toContain('DeFlow, the workflow thing');
    expect(result.exitCode).not.toBe(0);
  });
});

suite('the global bin directory is not on PATH (EPIC-20-S15, AC4)', () => {
  it('names the directory, says it is not on PATH, and offers the exact fix', async () => {
    const host = await machine('s15');

    const result = await runSetup(base(host));
    const link = stepOf(result, 'link');

    // The sentence nobody printed on 2026-08-12: which directory, and that it
    // is invisible.
    expect(link.detail).toContain(host.binDir);
    expect(link.detail).toMatch(/not on (?:your )?PATH/i);
    expect(link.detail).toContain(host.profileFile);
    expect(link.detail).toContain(`export PATH="${host.binDir}:$PATH"`);
    // AC4 — never "ok" on the strength of an exit code.
    expect(link.state).not.toBe('ok');
    // AC3 — and verification is attempted and fails, rather than being skipped
    // as unnecessary because the install "worked".
    expect(stepOf(result, 'verify').state).toBe('fail');
    expect(result.exitCode).not.toBe(0);
  });

  it("names pnpm's global bin directory too when it resolves elsewhere (scenario 2)", async () => {
    const host = await machine('s15-pnpm');
    const pnpmBin = join(tmp, 's15-pnpm-global');
    await mkdir(pnpmBin, { recursive: true });
    await writeFakePnpm(host.toolsDir, { log: host.pnpmLog, globalBin: pnpmBin });

    const result = await runSetup(base(host));

    expect(stepOf(result, 'link').detail).toContain(pnpmBin);
    expect(stepOf(result, 'link').detail).toContain(host.binDir);
  });
});

suite('the directory npm named is not there (AC4, AC5)', () => {
  /**
   * Found by performing AC15 rather than by reading the code.
   *
   * The clean room sat under a path with a UUID-shaped segment in it, and
   * `npm prefix -g` **redacted it** — npm 11 scrubs anything token-shaped out
   * of its own output, so it answered with `…/***\/scratchpad/…`, a directory
   * that does not exist. `setup` believed the string, wrote a `PATH` line
   * pointing nowhere into `.zshrc`, and the operator's next shell was left
   * exactly where 2026-08-12 left them.
   *
   * `verify` did catch it and the command exited 1, which is the story's
   * central claim holding up. But a profile file had already been edited to
   * add a directory that was never there, and AC5's promise is about what gets
   * written, not only about what gets reported. So the resolved directory is
   * an observation too: if it is not there, nothing is appended.
   */
  it('writes no profile line when the resolved bin directory does not exist', async () => {
    const host = await machine('ghost', { prefixDoesNotExist: true });

    const result = await runSetup(base(host, { yes: true }));
    const link = stepOf(result, 'link');

    // Nothing may be appended on the strength of a string npm printed.
    expect(existsSync(host.profileFile)).toBe(false);
    // It says which directory, and that it is the *existence* that is wrong —
    // otherwise this is indistinguishable from "not on PATH", which has a
    // different fix.
    expect(link.state).toBe('fail');
    expect(link.detail).toContain(host.reportedBinDir);
    expect(link.detail).toMatch(/does not exist/i);
    expect(result.exitCode).not.toBe(0);
  });
});

suite("doctor runs last and its verdict is not the installer's (EPIC-20-S19, AC9)", () => {
  it('exits 0 for a degraded machine and says which of the two happened', async () => {
    const host = await machine('s19', { binDirOnPath: true, doctor: 'degraded' });

    const result = await runSetup(base(host));
    const doctor = stepOf(result, 'doctor');

    // KAR-18.4 AC11 fixed 5 as "DeFlow cannot run here"; forwarding it would
    // call a perfectly good install a failed one.
    expect(doctor.state).toBe('warn');
    expect(doctor.data?.exitCode).toBe(5);
    expect(result.exitCode).toBe(0);
    // The report distinguishes the two outcomes in words, not only in states.
    expect(result.stdout).toMatch(/installed/i);
    expect(doctor.detail).toContain('runtime.state-dir');
    // …and the summary block's next action comes from doctor rather than from
    // a second wording invented here.
    expect(result.stdout).toContain('deflow doctor');
  });

  it('is skipped, and not spawned, when verification failed (scenario 2)', async () => {
    const host = await machine('s19-skipped', { binDirOnPath: true, installsNothing: true });

    const result = await runSetup(base(host));

    expect(stepOf(result, 'verify').state).toBe('fail');
    expect(stepOf(result, 'doctor').state).toBe('skipped');
    expect(await host.deflow()).toEqual([]);
  });
});

suite(
  "the adapter offer is KAR-18.8's, called rather than reimplemented (EPIC-20-S20, AC10)",
  () => {
    it('offers once, installs one package, and re-resolves afterwards', async () => {
      const host = await machine('s20', { binDirOnPath: true, vendors: ['claude'] });
      const scripted = scriptedPrompt('y');

      const result = await runSetup(
        base(host, { isTty: () => true, prompt: scripted.prompt, clock: undefined }),
      );

      expect(scripted.asked).toHaveLength(1);
      expect(scripted.asked[0]).toContain(`npm install -g ${CLAUDE_PKG}`);
      // Exactly one adapter install, and nothing wider.
      expect(await host.npm()).toContainEqual(['install', '-g', CLAUDE_PKG]);
      expect(stepOf(result, 'adapters').detail).toContain('claude');
      expect(result.exitCode).toBe(0);
    });

    it('spawns nothing when the offer is declined, and prints the command', async () => {
      const host = await machine('s20-no', { binDirOnPath: true, vendors: ['claude'] });
      const scripted = scriptedPrompt('n');

      const result = await runSetup(base(host, { isTty: () => true, prompt: scripted.prompt }));

      expect(scripted.asked).toHaveLength(1);
      expect(await host.npm()).not.toContainEqual(['install', '-g', CLAUDE_PKG]);
      expect(result.stdout).toContain(`npm install -g ${CLAUDE_PKG}`);
      expect(result.exitCode).toBe(0);
    });

    it('offers nothing under any flag when no vendor CLI resolves, and does not fail', async () => {
      const host = await machine('s20-none', { binDirOnPath: true });
      const scripted = scriptedPrompt('y');

      const result = await runSetup(
        base(host, { isTty: () => true, fix: true, prompt: scripted.prompt }),
      );

      expect(scripted.asked).toEqual([]);
      expect(await host.npm()).not.toContainEqual(['install', '-g', CLAUDE_PKG]);
      expect(stepOf(result, 'adapters').state).not.toBe('fail');
      // The hints are still printed: nothing installed is not nothing said.
      expect(result.stdout).toContain(CLAUDE_PKG);
      expect(result.exitCode).toBe(0);
    });
  },
);

suite('--json is safe to run from a script (EPIC-20-S21)', () => {
  it('parses, carries a per-step result, has no ANSI and no summary block', async () => {
    const host = await machine('s21', { binDirOnPath: true });

    const result = await runSetup(base(host, { json: true }));
    const parsed = JSON.parse(result.stdout) as {
      exitCode: number;
      steps: { id: string; state: string; detail: string }[];
    };

    expect(parsed.steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
    expect(parsed.exitCode).toBe(result.exitCode);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of ESC
    expect(result.stdout).not.toMatch(/\[/);
    expect(result.stdout).not.toContain('overall:');
    expect(result.stdout).not.toContain('next:');
  });

  it('never prompts and never blocks on a read, with stdin closed (AC10)', async () => {
    const host = await machine('s21-process', { binDirOnPath: true, vendors: ['claude'] });

    // A real process with a real closed stdin: "it never blocked on a read" is
    // not expressible in-process, because the thing that would block is the
    // event loop this assertion runs on.
    const child = spawn(process.execPath, [CLI_BIN, 'setup', '--json', '--from', 'deflowai'], {
      cwd: host.cwd,
      env: host.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString()));

    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (status) => resolve(status));
    });

    const stdout = out.join('');
    const parsed = JSON.parse(stdout) as { steps: { id: string }[]; exitCode: number };
    expect(parsed.steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
    expect(parsed.exitCode).toBe(code);
    expect(stdout).not.toContain('[y/N]');
    expect(err.join('')).not.toContain('[y/N]');
    // Nothing was installed for a vendor whose offer nobody could answer.
    expect(await host.npm()).not.toContainEqual(['install', '-g', CLAUDE_PKG]);
  }, 30_000);
});

suite(
  'nothing global is installed without consent except the tool itself (EPIC-20-S22, AC11)',
  () => {
    it('records exactly one global mutation over a whole run, and it is this package', async () => {
      const host = await machine('s22', { binDirOnPath: true, vendors: ['claude', 'codex'] });

      const result = await runSetup(base(host));

      const mutating = (await host.npm()).filter((argv) => argv[0] === 'install');
      expect(mutating).toEqual([['install', '-g', 'deflowai']]);
      for (const argv of await host.npm()) {
        expect(argv.join(' ')).not.toMatch(/\b(update|upgrade|audit|sudo)\b/);
      }
      expect(result.exitCode).toBe(0);
    });

    it('writes no lockfile into the directory the operator ran it from', async () => {
      const host = await machine('s22-cwd', { binDirOnPath: true });

      await runSetup(base(host));

      expect(existsSync(join(host.cwd, 'package-lock.json'))).toBe(false);
      expect(existsSync(join(host.cwd, 'node_modules'))).toBe(false);
    });
  },
);

suite('no network egress (EPIC-20-S24, AC12)', () => {
  it("carries npm's own words, attempts once, writes nothing, and exits non-zero", async () => {
    const stderr =
      'npm error code ENOTFOUND\n' +
      'npm error network request to https://registry.npmjs.org/deflow failed, reason: ' +
      'getaddrinfo ENOTFOUND registry.npmjs.org\n';
    const host = await machine('s24', { npmFailure: { exitCode: 1, stderr } });

    const result = await runSetup(base(host));
    const install = stepOf(result, 'install');

    expect(install.state).toBe('fail');
    // Verbatim, trimmed but not paraphrased.
    expect(install.detail).toContain('getaddrinfo ENOTFOUND registry.npmjs.org');
    // NF1 — one attempt. An offline machine costs one timeout, not three.
    expect((await host.npm()).filter((argv) => argv[0] === 'install')).toHaveLength(1);
    expect(existsSync(host.profileFile)).toBe(false);
    expect(existsSync(join(host.binDir, 'deflow'))).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('refuses on Windows in one sentence and touches nothing (AC13)', async () => {
    const host = await machine('s24-win32');

    const result = await runSetup(base(host, { platform: 'win32' }));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('NF5');
    expect(result.stderr).toContain('WSL2');
    expect(result.stdout).toBe('');
    // Nothing was read and nothing was written: no npm ran, no profile exists,
    // and the prefix is as empty as it started.
    expect(await host.npm()).toEqual([]);
    expect(existsSync(host.profileFile)).toBe(false);
    expect(existsSync(join(host.binDir, 'deflow'))).toBe(false);
  });
});

/**
 * EPIC-20-S34 — the short alias is a second `bin` key, and `verify` looks at it.
 *
 * The owner's decision of 2026-08-15 adds `dfl` beside `deflow`. There is no
 * prompt and no collision check in it: `dfl` is not the name of anything on a
 * POSIX machine, which is exactly why it was chosen over `df`, POSIX.1's
 * disk-free utility. What *is* here is the same rule the whole story is built
 * on — **verify by observation** — applied to the second name: npm links every
 * key in a `bin` map, so if the alias is not there afterwards, something about
 * the install is not what the manifest said, and saying so is cheaper than an
 * operator discovering it a week later.
 */
suite('the short alias is installed and observed, not assumed (EPIC-20-S34)', () => {
  it('reports both names and the one version they agree on', async () => {
    const host = await machine('s34', { binDirOnPath: true });

    const result = await runSetup(base(host));
    const verify = stepOf(result, 'verify');

    expect(verify.state).toBe('ok');
    // Both spawned, both read: the detail carries what each one answered.
    expect(verify.detail).toContain('deflow --version');
    expect(verify.detail).toContain('dfl --version');
    expect(verify.data).toMatchObject({ version: VERSION, aliasVersion: VERSION });
    expect(result.exitCode).toBe(0);
  });

  it('warns rather than fails when only the alias is missing', async () => {
    // An install from a release whose `bin` map predates the alias. The command
    // works, so this is not a failed install — but the report says the short
    // name is absent instead of leaving the operator to find out at a prompt.
    const host = await machine('s34-old', { binDirOnPath: true, withoutAlias: true });

    const result = await runSetup(base(host));
    const verify = stepOf(result, 'verify');

    expect(verify.state).toBe('warn');
    expect(verify.detail).toContain('dfl');
    expect(verify.data).toMatchObject({ version: VERSION, aliasVersion: null });
    // The steps after it still run: the tool is installed and works.
    expect(states(result)).toMatchObject({ doctor: 'ok', adapters: 'ok' });
    expect(result.exitCode).toBe(0);
  });
});
